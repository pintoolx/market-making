import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi } from 'viem';
import { aquaActivationAbi } from './aqua-activation.mjs';

/** Accept decoded contract errors only, never text containing an error name. */
export function isInactiveStrategyError(error) {
  let current = error;
  for (let i = 0; current && i < 16; i++, current = current.cause) {
    if (current.data?.errorName === 'StrategyNotActive') return true;
  }
  return false;
}

export const tradeAbi = parseAbi([
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function quote(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'function swap(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  'error StrategyNotActive()',
  'error DirectionDisabled()',
  'error AmountLimitExceeded()',
  'error InventoryLimitExceeded()',
  'error TakerTraitsDeadlineExpired()',
]);

/** SwapVM v1.0.2 exact-input, EOA settlement; no callbacks or custom receiver.
 * Encoding parity is checked against the pinned upstream SDK.
 * @returns {import('viem').Hex}
 */
export function walletTakerTraits(minimum, deadline = 0n) {
  if (minimum < 0n || minimum >= 1n << 256n || deadline < 0n || deadline >= 1n << 40n) throw new Error('Invalid swap threshold or deadline.');
  const thresholdBytes = minimum > 0n ? minimum.toString(16).padStart(64, '0') : '';
  const deadlineBytes = deadline > 0n ? deadline.toString(16).padStart(10, '0') : '';
  const thresholdEnd = thresholdBytes.length / 2;
  const end = thresholdEnd + deadlineBytes.length / 2;
  const offsets = [thresholdEnd, thresholdEnd, end, end, end, end, end, end, end, end];
  return `0x${offsets.reverse().map(n => n.toString(16).padStart(4, '0')).join('')}0041${thresholdBytes}${deadlineBytes}`;
}

/** Independently recover the exact order from its successful Maker ship transaction.
 * @param {import('viem').PublicClient} client
 * @param {{aqua: string, router: string, tokens: {WETH: string, USDC: string}}} deployment
 * @param {{shipTransaction: import('viem').Hex, strategyHash: import('viem').Hex, maker: string}} selected
 */
export async function verifiedTradeOrder(client, deployment, selected) {
  if (await client.getChainId() !== 11155111) throw new Error('Use Ethereum Sepolia.');
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: selected.shipTransaction }),
    client.getTransactionReceipt({ hash: selected.shipTransaction }),
  ]);
  if (receipt.status !== 'success' || tx.from.toLowerCase() !== selected.maker.toLowerCase()
    || tx.to?.toLowerCase() !== deployment.aqua.toLowerCase() || tx.value !== 0n || tx.blockHash !== receipt.blockHash) throw new Error('The activation receipt does not match this Maker.');
  const decoded = decodeFunctionData({ abi: aquaActivationAbi, data: tx.input });
  if (decoded.functionName !== 'ship') throw new Error('Expected an Aqua activation.');
  const [app, strategy, tokens] = decoded.args;
  if (app.toLowerCase() !== deployment.router.toLowerCase() || keccak256(strategy).toLowerCase() !== selected.strategyHash.toLowerCase()
    || tokens.length !== 2 || tokens[0].toLowerCase() !== deployment.tokens.WETH.toLowerCase()
    || tokens[1].toLowerCase() !== deployment.tokens.USDC.toLowerCase()) throw new Error('The activated program differs from this strategy.');
  const [order] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], strategy);
  // The reviewed release uses Aqua authentication only: no hooks or custom receiver.
  if (order.maker.toLowerCase() !== selected.maker.toLowerCase() || order.traits !== (1n << 254n)) throw new Error('Unsupported Maker settlement settings.');
  return order;
}
