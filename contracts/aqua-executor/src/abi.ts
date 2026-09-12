import { parseAbi } from 'viem'

// Hand-written from aqua@9c5c42e (src/interfaces/IAqua.sol, AquaRouter's Multicall)
// and swap-vm@v1.0.2 (src/interfaces/ISwapVM.sol, src/libs/TakerTraits.sol, src/instructions/Controls.sol).
const errors = [
  'error MaxNumberOfTokensExceeded(uint256 tokensCount, uint256 maxTokensCount)',
  'error StrategiesMustBeImmutable(address app, bytes32 strategyHash)',
  'error DockingShouldCloseAllTokens(address app, bytes32 strategyHash)',
  'error PushToNonActiveStrategyPrevented(address maker, address app, bytes32 strategyHash, address token)',
  'error SafeBalancesForTokenNotInActiveStrategy(address maker, address app, bytes32 strategyHash, address token)',
  'error AquaBalanceInsufficientAfterTakerPush(uint256 balance, uint256 preBalance, uint256 amount, uint256 amountNetPulled)',
  'error MakerTraitsUnwrapIsIncompatibleWithAqua()',
  'error MakerTraitsCustomReceiverIsIncompatibleWithAqua()',
  'error TakerTraitsInsufficientMinOutputAmount(uint256 amountOut, uint256 amountOutMin)',
  'error TakerTraitsAmountOutMustBeGreaterThanZero(uint256 amountOut)',
  'error TakerTraitsExceedingMaxInputAmount(uint256 amountIn, uint256 amountInMax)',
  'error TakerTraitsDeadlineExpired()',
  'error DeadlineReached(address taker, uint256 deadline)',
  'error SafeTransferFromFailed()',
  'error SafeTransferFailed()',
  'error ForceApproveFailed()',
] as const

export const errorsAbi = parseAbi(errors)

export const aquaAbi = parseAbi([
  ...errors,
  'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32 strategyHash)',
  'function dock(address app, bytes32 strategyHash, address[] tokens)',
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
  'function multicall(bytes[] data)',
  'event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)',
  'event Docked(address maker, address app, bytes32 strategyHash)',
  'event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount)',
  'event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)',
])

export const routerAbi = parseAbi([
  ...errors,
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function hash(Order order) view returns (bytes32)',
  'function quote(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'function swap(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
])

export const mockTokenAbi = parseAbi(['function mint(address to, uint256 amount)'])
