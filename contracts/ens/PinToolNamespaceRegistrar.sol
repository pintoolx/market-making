// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IEnsRegistry {
    struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }
    function getState(uint256 anyId) external view returns (State memory);
    function getSubregistry(string calldata label) external view returns (address);
    function register(string calldata label, address owner, address registry, address resolver, uint256 roles, uint64 expiry) external returns (uint256);
}
interface IEnsFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

/// @notice Self-service names under a platform-managed ENSv2 namespace. No asset permissions.
/// @dev Grant only ROLE_REGISTRAR on the platform UserRegistry to this contract.
contract PinToolNamespaceRegistrar {
    IEnsRegistry public immutable ETH_REGISTRY;
    IEnsRegistry public immutable REGISTRY;
    IEnsFactory public immutable FACTORY;
    address public immutable REGISTRY_IMPLEMENTATION;
    address public immutable RESOLVER_IMPLEMENTATION;
    bytes32 public immutable ROOT_NODE;
    string public rootLabel;
    mapping(address => string) public providerLabel;

    uint256 private constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    // Keep Provider names non-transferable in the standard flow. The platform retains root administration.
    uint256 private constant NAME_ROLES = (1 << 16) | (1 << 20) | (1 << 24);
    event ProviderRegistered(address indexed provider, string label, address registry, address resolver, uint64 expiry);
    error InvalidLabel();
    error NamespaceUnavailable();
    error AlreadyRegistered();

    constructor(address ethRegistry, address registry, address factory, address registryImplementation, address resolverImplementation, string memory label) {
        _checkLabel(label);
        ETH_REGISTRY = IEnsRegistry(ethRegistry);
        REGISTRY = IEnsRegistry(registry);
        FACTORY = IEnsFactory(factory);
        REGISTRY_IMPLEMENTATION = registryImplementation;
        RESOLVER_IMPLEMENTATION = resolverImplementation;
        rootLabel = label;
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        ROOT_NODE = keccak256(abi.encodePacked(ethNode, keccak256(bytes(label))));
    }

    function register(string calldata label) external returns (address registry, address resolver) {
        _checkLabel(label);
        if (bytes(providerLabel[msg.sender]).length != 0) revert AlreadyRegistered();
        IEnsRegistry.State memory root = ETH_REGISTRY.getState(uint256(keccak256(bytes(rootLabel))));
        if (root.status != 2 || root.expiry <= block.timestamp || ETH_REGISTRY.getSubregistry(rootLabel) != address(REGISTRY)) revert NamespaceUnavailable();
        // Set before external calls. A failure rolls back this and both proxy deployments.
        providerLabel[msg.sender] = label;
        bytes32 node = keccak256(abi.encodePacked(ROOT_NODE, keccak256(bytes(label))));
        registry = FACTORY.deployProxy(REGISTRY_IMPLEMENTATION, uint256(keccak256(abi.encode(node, msg.sender, "registry"))),
            abi.encodeWithSignature("initialize(address,uint256)", msg.sender, ALL_ROLES));
        bytes[] memory setters = new bytes[](1);
        setters[0] = abi.encodeWithSignature("setAddr(bytes32,address)", node, msg.sender);
        resolver = FACTORY.deployProxy(RESOLVER_IMPLEMENTATION, uint256(keccak256(abi.encode(node, msg.sender, "resolver"))),
            abi.encodeWithSignature("initialize(address,uint256,bytes[])", msg.sender, ALL_ROLES, setters));
        REGISTRY.register(label, msg.sender, registry, resolver, NAME_ROLES | (NAME_ROLES << 128), root.expiry);
        emit ProviderRegistered(msg.sender, label, registry, resolver, root.expiry);
    }

    function _checkLabel(string memory label) private pure {
        bytes memory value = bytes(label);
        if (value.length < 3 || value.length > 32 || value[0] == 0x2d || value[value.length - 1] == 0x2d) revert InvalidLabel();
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d)) revert InvalidLabel();
        }
    }
}
