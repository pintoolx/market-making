import {
  ConsensusAggregationByFields, EVMClient, HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER, blockNumber, bytesToHex,
  encodeCallMsg, getHeader, getNetwork, identical, json, median, ok,
  protoBigIntToBigint, type HTTPSendRequester, type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi,
  zeroAddress, type Address, type Hex,
} from "viem";
import {
  assertFresh, configSchema, PRICE_DECIMALS, valueWallet, type Config,
} from "./config";

import { parseBook, parseCandles, summarizeMarket, type MarketObservation } from "./kraken";

export type { Config } from "./config";
export const tokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export function fetchMarket(
  requester: HTTPSendRequester, config: Config, observedAt: bigint,
): MarketObservation {
  const read = (url: string) => {
    const response = requester.sendRequest({
      url, method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      cacheSettings: { store: false },
    }).result();
    if (!ok(response)) throw new Error(`Market API returned HTTP ${response.statusCode}`);
    const date = getHeader(response, "date");
    const dateMs = date ? Date.parse(date) : NaN;
    if (!Number.isSafeInteger(dateMs)) throw new Error("Market API response is missing a valid Date header");
    const at = BigInt(Math.floor(dateMs / 1000));
    assertFresh("HTTP response", at, observedAt, config.maxHttpResponseAgeSeconds, config.clockSkewSeconds);
    return { body: json(response), at };
  };
  const book = read(config.bookUrl);
  const candles = read(config.ohlcUrl);
  const result = {
    ...parseBook(book.body, observedAt, config), ...parseCandles(candles.body, observedAt),
    httpResponseAt: book.at < candles.at ? book.at : candles.at,
  };
  summarizeMarket(result, observedAt, config);
  return result;
}

export function observeMarket(runtime: Runtime<unknown>, input: Config) {
  const config = configSchema.parse(input);
  const observedAt = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const market = new HTTPClient().sendRequest(
    runtime, fetchMarket,
    ConsensusAggregationByFields<MarketObservation>({
      bid: median, ask: median, bidAt: median, askAt: median, httpResponseAt: median,
      closePrices: identical, tradeCounts: identical, candleOpenTimes: identical,
    }),
  )(config, observedAt).result();
  const summary = summarizeMarket(market, observedAt, config);

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error("Ethereum Sepolia is unavailable in the CRE SDK network registry");
  const evm = new EVMClient(network.chainSelector.selector);
  const header = evm.headerByNumber(runtime, { blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result().header;
  if (!header?.blockNumber || header.hash.length !== 32) throw new Error("Finalized block header is incomplete");
  const height = protoBigIntToBigint(header.blockNumber);
  if (height <= 0n) throw new Error("Invalid finalized block number");
  assertFresh("Finalized block", header.timestamp, observedAt, config.maxFinalizedBlockAgeSeconds, config.clockSkewSeconds);

  const read = (address: Address, data: Hex): Hex => bytesToHex(evm.callContract(runtime, {
    call: encodeCallMsg({ from: zeroAddress, to: address, data }),
    blockNumber: blockNumber(height),
  }).result().data);
  const readToken = (address: Address, expectedDecimals: number) => {
    const decimals = decodeFunctionResult({
      abi: tokenAbi, functionName: "decimals",
      data: read(address, encodeFunctionData({ abi: tokenAbi, functionName: "decimals" })),
    });
    if (decimals !== expectedDecimals) throw new Error(`Unexpected token decimals at ${address}`);
    const balance = decodeFunctionResult({
      abi: tokenAbi, functionName: "balanceOf",
      data: read(address, encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [config.maker as Address] })),
    });
    return { address, decimals, balanceAtomic: balance.toString(), balance: formatUnits(balance, decimals) };
  };
  const weth = readToken(config.weth, 18);
  const usdc = readToken(config.usdc, 6);
  const price = formatUnits(summary.midpoint, PRICE_DECIMALS);
  const result = {
    schemaVersion: "market-observation-v2",
    observedAt: observedAt.toString(),
    maker: config.maker,
    chain: {
      chainId: 11155111, chainSelector: network.chainSelector.selector.toString(),
      blockNumber: height.toString(), blockHash: bytesToHex(header.hash),
      blockTimestamp: header.timestamp.toString(), finality: "finalized",
    },
    price: {
      source: config.bookUrl, pair: "ETH/USDC", kind: "mid-price",
      value: price, scaled: summary.midpoint.toString(), decimals: PRICE_DECIMALS,
      bidScaled: market.bid.toString(), askScaled: market.ask.toString(),
      bidUpdatedAt: market.bidAt.toString(), askUpdatedAt: market.askAt.toString(),
      httpResponseAt: market.httpResponseAt.toString(), spreadBps: summary.spreadBps,
    },
    volatility: { source: config.ohlcUrl, ...summary.volatility },
    balanceScope: "maker-wallet",
    tokens: { WETH: weth, USDC: usdc },
    referenceValuation: valueWallet(BigInt(weth.balanceAtomic), BigInt(usdc.balanceAtomic), summary.midpoint),
    authorizationInput: {
      complete: true,
      marketSnapshot: {
        midPrice: price, volatilityBps: summary.volatility.bps,
        balance0: weth.balanceAtomic, balance1: usdc.balanceAtomic, decimals0: 18, decimals1: 6,
      },
    },
  };
  runtime.log(`Market snapshot: ETH/USDC midpoint=${price}; volatility30m=${summary.volatility.bps} bps; maker WETH=${weth.balance}; USDC=${usdc.balance}; finalized block=${height}`);
  return result;
}
