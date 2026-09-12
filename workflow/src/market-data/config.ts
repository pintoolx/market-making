import { formatUnits, isAddress } from "viem";
import { z } from "zod";

// Confirmed Ethereum Sepolia deployment bundle in market-making/contracts/aqua-executor.
export const WETH = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";
export const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
export const BOOK_URL = "https://api.kraken.com/0/public/Depth?pair=ETHUSDC&count=1";
export const OHLC_URL = "https://api.kraken.com/0/public/OHLC?pair=ETHUSDC&interval=1";
export const PRICE_DECIMALS = 8;
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

export const configSchema = z.object({
  schedule: z.string().min(1),
  chainSelectorName: z.literal("ethereum-testnet-sepolia"),
  maker: z.string().refine((value) => isAddress(value) && !/^0x0{40}$/i.test(value), "Invalid maker address"),
  weth: z.literal(WETH),
  usdc: z.literal(USDC),
  bookUrl: z.literal(BOOK_URL),
  ohlcUrl: z.literal(OHLC_URL),
  maxHttpResponseAgeSeconds: z.number().int().min(1).max(300),
  maxFinalizedBlockAgeSeconds: z.number().int().min(1).max(3600),
  clockSkewSeconds: z.number().int().min(0).max(30),
  maxBookAgeSeconds: z.number().int().min(1).max(300),
  maxSpreadBps: z.number().int().min(1).max(1000),
  lookbackMinutes: z.literal(30),
  completionLagSeconds: z.literal(60),
  minTradedIntervals: z.number().int().min(1).max(30),
  maxLastTradeAgeSeconds: z.number().int().min(60).max(1800),
}).strict();
export type Config = z.infer<typeof configSchema>;

export function assertFresh(
  label: string, timestamp: bigint, now: bigint,
  maxAgeSeconds: number, clockSkewSeconds: number,
): void {
  if (timestamp <= 0n || timestamp > now + BigInt(clockSkewSeconds)) {
    throw new Error(`${label} timestamp is invalid or in the future`);
  }
  if (now - timestamp > BigInt(maxAgeSeconds)) throw new Error(`${label} is stale`);
}

export function valueWallet(wethBalance: bigint, usdcBalance: bigint, price: bigint) {
  if (wethBalance < 0n || usdcBalance < 0n || price <= 0n) {
    throw new Error("Invalid wallet valuation inputs");
  }
  // Atomic USDC units; round down only at the final conversion to six decimals.
  const wethValue = (wethBalance * price * 10n ** 6n) / (10n ** 18n * PRICE_SCALE);
  const total = wethValue + usdcBalance;
  return {
    wethValueUsdcAtomic: wethValue.toString(),
    totalValueUsdcAtomic: total.toString(),
    totalValueUsdc: formatUnits(total, 6),
    wethShareBps: total === 0n ? null : Number((wethValue * 10000n) / total),
  };
}
