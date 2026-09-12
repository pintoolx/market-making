// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IExtruction, IStaticExtruction, SwapQuery, SwapRegisters} from "./vendor/SwapVMInterfaces.sol";

interface IAquaInventory {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token) external view returns (uint248, uint8);
}
interface IAquaRouter { function AQUA() external view returns (address); }

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReportReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Concentrated LP Guard: report-v1 transport and version-2 envelope; real Aqua inventory, zero fee only.
/// @dev Immutable transport configuration. Simulation must use a separate testnet deployment.
contract AquaGuardV2 is IReportReceiver, IExtruction, IStaticExtruction {
    struct GuardReportV1 {
        uint16 schemaVersion;
        uint256 chainId;
        address guard;
        address router;
        address maker;
        bytes32 strategyHash;
        address token0;
        address token1;
        uint64 nonce;
        uint48 validAfter;
        uint48 validUntil;
        uint8 allowedDirections;
        uint128 maxAmount0PerSwap;
        uint128 maxAmount1PerSwap;
        uint128 maxPostBalance0;
        uint128 maxPostBalance1;
    }

    struct StoredReport {
        GuardReportV1 report;
        bytes32 digest;
    }

    IAquaInventory public immutable aqua;
    uint8 public constant guardVersion = 2;
    address public immutable forwarder;
    address public immutable router;
    bytes32 public immutable workflowId;
    address public immutable workflowOwner;
    bool public immutable simulationMode;
    uint256 public constant MAX_REPORT_LIFETIME = 600;
    mapping(address maker => mapping(bytes32 strategyHash => StoredReport)) private reports;
    mapping(address maker => bytes32 strategyHash) public activeStrategyHash;

    error InvalidConfiguration();
    error UnauthorizedForwarder();
    error UnauthorizedWorkflow();
    error InvalidMetadata();
    error InvalidReport();
    error InvalidReportDomain();
    error ReportNotCurrent();
    error ReportReplay();
    error UnauthorizedRouter();
    error InvalidEnvelope();
    error MissingReport();
    error StrategyNotActive();
    error UnsupportedSwap();
    error TokenPairMismatch();
    error DirectionDisabled();
    error AmountLimitExceeded();
    error InventoryLimitExceeded();

    event ReportAccepted(address indexed maker, bytes32 indexed strategyHash, uint64 nonce, bytes32 digest, uint48 validUntil);
    event ActiveStrategyChanged(address indexed maker, bytes32 indexed previousStrategyHash, bytes32 indexed strategyHash);

    constructor(address forwarder_, address router_, bytes32 workflowId_, address workflowOwner_, bool simulationMode_) {
        if (forwarder_.code.length == 0 || router_.code.length == 0) revert InvalidConfiguration();
        if (simulationMode_) {
            if ((block.chainid != 31337 && block.chainid != 84532) || workflowId_ != bytes32(0) || workflowOwner_ != address(0)) {
                revert InvalidConfiguration();
            }
        } else if (workflowId_ == bytes32(0) || workflowOwner_ == address(0)) {
            revert InvalidConfiguration();
        }
        address aqua_ = IAquaRouter(router_).AQUA();
        if (aqua_.code.length == 0) revert InvalidConfiguration();
        aqua = IAquaInventory(aqua_);
        forwarder = forwarder_;
        router = router_;
        workflowId = workflowId_;
        workflowOwner = workflowOwner_;
        simulationMode = simulationMode_;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IReportReceiver).interfaceId || id == type(IERC165).interfaceId;
    }

    function getReport(address maker, bytes32 strategyHash) external view returns (GuardReportV1 memory, bytes32) {
        StoredReport storage saved = reports[maker][strategyHash];
        return (saved.report, saved.digest);
    }

    function onReport(bytes calldata metadata, bytes calldata payload) external {
        if (msg.sender != forwarder) revert UnauthorizedForwarder();
        if (!simulationMode) {
            // KeystoneForwarder: packed workflowId (32), name (10), owner (20), reportId (2).
            if (metadata.length != 64) revert InvalidMetadata();
            if (bytes32(metadata[:32]) != workflowId || address(bytes20(metadata[42:62])) != workflowOwner) {
                revert UnauthorizedWorkflow();
            }
        }
        if (payload.length != 512) revert InvalidReport();
        GuardReportV1 memory r = abi.decode(payload, (GuardReportV1));
        bytes32 digest = keccak256(payload);
        if (keccak256(abi.encode(r)) != digest || r.schemaVersion != 1 || r.maker == address(0) ||
            r.strategyHash == bytes32(0) || r.token0 == address(0) || r.token1 == address(0) ||
            r.token0 == r.token1 || r.allowedDirections > 3 || r.nonce == 0) revert InvalidReport();
        if (r.chainId != block.chainid || r.guard != address(this) || r.router != router) revert InvalidReportDomain();
        if (r.validAfter > block.timestamp || r.validUntil <= block.timestamp ||
            r.validUntil - r.validAfter > MAX_REPORT_LIFETIME) revert ReportNotCurrent();
        if (r.allowedDirections != 0 && (r.maxAmount0PerSwap == 0 || r.maxAmount1PerSwap == 0 ||
            r.maxPostBalance0 == 0 || r.maxPostBalance1 == 0)) revert InvalidReport();

        StoredReport storage saved = reports[r.maker][r.strategyHash];
        if (r.nonce == saved.report.nonce && digest == saved.digest) return;
        if (r.nonce <= saved.report.nonce) revert ReportReplay();
        saved.report = r;
        saved.digest = digest;
        bytes32 previous = activeStrategyHash[r.maker];
        bytes32 next = r.allowedDirections == 0 ? bytes32(0) : r.strategyHash;
        if (previous != next) {
            activeStrategyHash[r.maker] = next;
            emit ActiveStrategyChanged(r.maker, previous, next);
        }
        emit ReportAccepted(r.maker, r.strategyHash, r.nonce, digest, r.validUntil);
    }

    /// @dev Quotes and swaps perform identical read-only checks. The Guard does not consume taker arguments.
    function extruction(
        bool, uint256 nextPC, SwapQuery calldata query, SwapRegisters calldata swap,
        bytes calldata args, bytes calldata
    ) external view override(IExtruction, IStaticExtruction) returns (uint256, uint256, SwapRegisters memory) {
        if (msg.sender != router) revert UnauthorizedRouter();
        // version:u8 | token0:address | token1:address | four u128 caps, all big-endian.
        if (args.length != 105 || uint8(args[0]) != 2) revert InvalidEnvelope();
        address token0 = address(bytes20(args[1:21]));
        address token1 = address(bytes20(args[21:41]));
        if (token0 == address(0) || token1 == address(0) || token0 == token1) revert InvalidEnvelope();
        GuardReportV1 storage r = reports[query.maker][query.orderHash].report;
        if (r.nonce == 0) revert MissingReport();
        if (activeStrategyHash[query.maker] != query.orderHash) revert StrategyNotActive();
        if (block.timestamp < r.validAfter || block.timestamp >= r.validUntil) revert ReportNotCurrent();
        if (!query.isExactIn || swap.amountNetPulled != 0 || swap.amountIn == 0 || swap.amountOut == 0 ||
            swap.amountOut > swap.balanceOut) revert UnsupportedSwap();
        if (r.token0 != token0 || r.token1 != token1) revert TokenPairMismatch();
        bool zeroForOne = query.tokenIn == token0 && query.tokenOut == token1;
        if (!zeroForOne && !(query.tokenIn == token1 && query.tokenOut == token0)) revert TokenPairMismatch();
        if ((r.allowedDirections & (zeroForOne ? 1 : 2)) == 0) revert DirectionDisabled();

        uint256 amount0 = zeroForOne ? swap.amountIn : swap.amountOut;
        uint256 amount1 = zeroForOne ? swap.amountOut : swap.amountIn;
        if (amount0 > _min(r.maxAmount0PerSwap, uint128(bytes16(args[41:57]))) ||
            amount1 > _min(r.maxAmount1PerSwap, uint128(bytes16(args[57:73])))) revert AmountLimitExceeded();
        // Concentrate mutates VM balance registers to include virtual pricing reserves.
        // This terminal, zero-fee template accounts only for actual Aqua inventory.
        (uint248 realIn, uint8 countIn) = aqua.rawBalances(query.maker, router, query.orderHash, query.tokenIn);
        (uint248 realOut, uint8 countOut) = aqua.rawBalances(query.maker, router, query.orderHash, query.tokenOut);
        if (countIn != 2 || countOut != 2 || swap.amountOut > realOut) revert UnsupportedSwap();
        uint256 postIn = uint256(realIn) + swap.amountIn;
        uint256 postOut = uint256(realOut) - swap.amountOut;
        if ((zeroForOne ? postIn : postOut) > _min(r.maxPostBalance0, uint128(bytes16(args[73:89]))) ||
            (zeroForOne ? postOut : postIn) > _min(r.maxPostBalance1, uint128(bytes16(args[89:105])))) {
            revert InventoryLimitExceeded();
        }
        return (nextPC, 0, swap);
    }

    function _min(uint128 a, uint128 b) private pure returns (uint128) { return a < b ? a : b; }
}
