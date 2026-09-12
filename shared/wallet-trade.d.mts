import type { Hex, Address, PublicClient, ParseAbi } from 'viem';
export declare function isInactiveStrategyError(error: unknown): boolean;
export declare function walletErrorMessage(error: unknown): string;

export declare const tradeAbi: ParseAbi<[
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function quote(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'function swap(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  'error StrategyNotActive()',
  'error DirectionDisabled()',
  'error AmountLimitExceeded()',
  'error InventoryLimitExceeded()',
  'error TakerTraitsDeadlineExpired()',
]>;
export declare function walletTakerTraits(minimum: bigint, deadline?: bigint): Hex;
export declare function verifiedTradeOrder(client: PublicClient, deployment: { aqua: string; router: string; tokens: { WETH: string; USDC: string } }, selected: { shipTransaction: Hex; strategyHash: Hex; maker: string }): Promise<{ maker: Address; traits: bigint; data: Hex }>;
