import { expect, test as unitTest } from "bun:test";
import { blockNumber, bytesToBase64, getNetwork, hexToBase64, protoBigIntToBigint } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, addContractMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { observeMarket, tokenAbi } from "./observe";
const onCronTrigger = (runtime: Parameters<typeof observeMarket>[0] & { config: unknown }) => JSON.stringify(observeMarket(runtime, configSchema.parse(runtime.config)));
const initWorkflow = (input: unknown) => configSchema.parse(input);
import { assertFresh, configSchema, valueWallet } from "./config";
import { parseBook, parseCandles, summarizeMarket, windowEnd } from "./kraken";
import { volatilityBps } from "../market-math";
import staging from "./defaults.json";

const config = configSchema.parse(staging);
const NOW = 1_800_000_000;
const HEIGHT = 12_345_678n;
const HASH = `0x${"ab".repeat(32)}` as const;
const book = () => ({ error: [], result: { ETHUSDC: {
  bids: [["2499", "1", NOW]], asks: [["2501", "1", NOW]],
} } });
const candles = () => ({ error: [], result: { last: NOW - 60, ETHUSDC:
  Array.from({ length: 33 }, (_, i) => [windowEnd(BigInt(NOW)) - (31 - i) * 60,
    "2500", "2500", "2500", "2500", "2500", "1", 2]),
} });
const encoded = (body: unknown) => bytesToBase64(new TextEncoder().encode(JSON.stringify(body)));

function setup() {
  const runtime = newTestRuntime(null, { timeProvider: () => NOW * 1000 }, config);
  const http = HttpActionsMock.testInstance();
  const response = {
    statusCode: 200,
    multiHeaders: { date: { values: [new Date(NOW * 1000).toUTCString()] } },
    body: "",
  };
  http.sendRequest = (request) => {
    expect([config.bookUrl, config.ohlcUrl]).toContain(request.url);
    expect(request.method).toBe("GET");
    expect(request.cacheSettings?.store).toBe(false);
    return { ...response, body: encoded(request.url === config.bookUrl ? book() : candles()) };
  };
  const selector = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true })!.chainSelector.selector;
  const evm = EvmMock.testInstance(selector);
  evm.headerByNumber = () => ({ header: {
    blockNumber: blockNumber(HEIGHT), timestamp: String(NOW - 600),
    hash: hexToBase64(HASH), parentHash: hexToBase64(HASH),
  } });
  const weth = addContractMock(evm, { address: config.weth, abi: tokenAbi });
  const usdc = addContractMock(evm, { address: config.usdc, abi: tokenAbi });
  weth.decimals = () => 18;
  usdc.decimals = () => 6;
  weth.balanceOf = (owner) => { expect(owner).toBe(config.maker); return 4_000_000_000_000_000n; };
  usdc.balanceOf = (owner) => { expect(owner).toBe(config.maker); return 10_000_000n; };
  let calls = 0;
  const dispatch = evm.callContract!;
  evm.callContract = (request) => {
    calls++;
    expect(protoBigIntToBigint(request.blockNumber!)).toBe(HEIGHT);
    return dispatch(request);
  };
  evm.writeReport = () => { throw new Error("Observation workflow must never write a report"); };
  return { runtime, http, response, evm, weth, usdc, calls: () => calls };
}

unitTest("bid/ask prices reject stale, wrong units, crossed books, empty levels and excess precision", () => {
  expect(parseBook(book(), BigInt(NOW), config).bid).toBe(249900000000n);
  for (const price of [0, "0", "-1", "NaN", "1e3", "1.000000001", "01", ""]) {
    const bad = book(); bad.result.ETHUSDC.bids[0]![0] = price;
    expect(() => parseBook(bad, BigInt(NOW), config)).toThrow();
  }
  const stale = book(); stale.result.ETHUSDC.bids[0]![2] = NOW - 91;
  expect(() => parseBook(stale, BigInt(NOW), config)).toThrow("Bid is stale");
  const crossed = book(); crossed.result.ETHUSDC.bids[0]![0] = "2502";
  expect(() => parseBook(crossed, BigInt(NOW), config)).toThrow("crossed");
  expect(() => parseBook({ error: [], result: { ETHUSD: book().result.ETHUSDC } }, BigInt(NOW), config)).toThrow();
  const wide = book(); wide.result.ETHUSDC.asks[0]![0] = "2600";
  expect(() => parseBook(wide, BigInt(NOW), config)).toThrow("spread");
  const empty = book(); empty.result.ETHUSDC.asks[0]![1] = "0";
  expect(() => parseBook(empty, BigInt(NOW), config)).toThrow("Empty");
});

unitTest("volatility uses 30 returns, conservatively rounds and excludes unfinished candles", () => {
  const flat = Array<bigint>(31).fill(100n);
  expect(volatilityBps(flat)).toBe(0);
  // A single +1% minute followed by a flat price: exactly 100 bps.
  expect(volatilityBps([100n, ...Array<bigint>(30).fill(101n)])).toBe(100);
  expect(volatilityBps([3n, ...Array<bigint>(30).fill(4n)])).toBe(3334);
  expect(() => volatilityBps(flat.slice(1))).toThrow();
  const source = candles(); source.result.ETHUSDC[32]![4] = "999999";
  const parsed = parseCandles(source, BigInt(NOW));
  expect(parsed.closePrices).toHaveLength(31);
  expect(volatilityBps(parsed.closePrices.map(BigInt))).toBe(0);
  expect(parsed.candleOpenTimes.at(-1)).toBe(windowEnd(BigInt(NOW)) - 60);
  const missing = candles(); missing.result.ETHUSDC.splice(4, 1);
  expect(() => parseCandles(missing, BigInt(NOW))).toThrow("Missing completed");
  const duplicate = candles(); duplicate.result.ETHUSDC[1] = duplicate.result.ETHUSDC[0]!;
  expect(() => parseCandles(duplicate, BigInt(NOW))).toThrow("Duplicate");
  const malformed = candles(); malformed.result.ETHUSDC[3]![3] = "2600";
  expect(() => parseCandles(malformed, BigInt(NOW))).toThrow("OHLC price bounds");
});

unitTest("carry-forward zero-trade candles are exposed and illiquid windows fail closed", () => {
  const observation = { ...parseBook(book(), BigInt(NOW), config),
    ...parseCandles(candles(), BigInt(NOW)), httpResponseAt: BigInt(NOW) };
  observation.tradeCounts.fill(0); observation.tradeCounts.fill(1, 1, 6);
  expect(() => summarizeMarket(observation, BigInt(NOW), config)).toThrow("Last traded candle is stale");
  observation.tradeCounts.fill(0); observation.tradeCounts.fill(1, 26);
  expect(summarizeMarket(observation, BigInt(NOW), config).volatility.zeroTradeIntervals).toBe(25);
  observation.tradeCounts[26] = 0;
  expect(() => summarizeMarket(observation, BigInt(NOW), config)).toThrow("Insufficient traded");
});

unitTest("valuation preserves atomic precision, final rounding and empty-wallet semantics", () => {
  expect(valueWallet(4_000_000_000_000_000n, 10_000_000n, 250012345678n)).toEqual({
    wethValueUsdcAtomic: "10000493", totalValueUsdcAtomic: "20000493", totalValueUsdc: "20.000493", wethShareBps: 5000,
  });
  expect(valueWallet(0n, 0n, 100000000n).wethShareBps).toBeNull();
  expect(valueWallet(1n, 1n, 100000000n).totalValueUsdcAtomic).toBe("1");
  expect(valueWallet(10n ** 30n, 0n, 100000000n).totalValueUsdcAtomic).toBe("1000000000000000000");
});

unitTest("freshness boundaries reject stale, zero and future timestamps", () => {
  expect(() => assertFresh("data", 910n, 1000n, 90, 15)).not.toThrow();
  for (const timestamp of [909n, 0n, 1016n]) {
    expect(() => assertFresh("data", timestamp, 1000n, 90, 15)).toThrow();
  }
});

unitTest("configuration rejects wrong chain, token, zero maker and unknown fields", () => {
  for (const patch of [{ chainSelectorName: "ethereum-mainnet" }, { weth: config.usdc },
    { maker: `0x${"00".repeat(20)}` }, { publishMode: "don-report" }]) {
    expect(() => initWorkflow({ ...config, ...patch } as typeof config)).toThrow();
  }
  expect(initWorkflow(config).schedule).toBe(config.schedule);
});

test("HTTP and EVM capabilities produce a wallet snapshot at one finalized block without authorizing", () => {
  const t = setup();
  const result = JSON.parse(onCronTrigger(t.runtime));
  expect(t.calls()).toBe(4);
  expect(result.chain).toMatchObject({ blockNumber: HEIGHT.toString(), blockHash: HASH, finality: "finalized" });
  expect(result.tokens.WETH.balance).toBe("0.004");
  expect(result.tokens.USDC.balance).toBe("10");
  expect(result.referenceValuation.totalValueUsdcAtomic).toBe("20000000");
  expect(result.price.bidUpdatedAt).toBe(String(NOW));
  expect(result.authorizationInput.complete).toBe(true);
  expect(result.authorizationInput.marketSnapshot.volatilityBps).toBe(0);
  expect(result.volatility.tradedIntervals).toBe(30);
  expect(t.runtime.getLogs().join("\n")).toContain("Market snapshot:");
});

test("HTTP failure, absent Date and stale responses stop before chain reads", () => {
  const t = setup();
  t.response.statusCode = 503;
  expect(() => onCronTrigger(t.runtime)).toThrow("HTTP 503");
  t.response.statusCode = 200;
  t.response.multiHeaders.date.values = [];
  expect(() => onCronTrigger(t.runtime)).toThrow("Date header");
  t.response.multiHeaders.date.values = [new Date((NOW - 91) * 1000).toUTCString()];
  expect(() => onCronTrigger(t.runtime)).toThrow("HTTP response is stale");
  expect(t.calls()).toBe(0);
});

test("stale or malformed finalized headers fail before token reads", () => {
  const t = setup();
  t.evm.headerByNumber = () => ({ header: { blockNumber: blockNumber(HEIGHT), timestamp: String(NOW - 1801), hash: hexToBase64(HASH) } });
  expect(() => onCronTrigger(t.runtime)).toThrow("Finalized block is stale");
  t.evm.headerByNumber = () => ({});
  expect(() => onCronTrigger(t.runtime)).toThrow("header is incomplete");
  expect(t.calls()).toBe(0);
});

test("wrong token decimals and malformed contract return data cannot produce a snapshot", () => {
  const t = setup();
  t.usdc.decimals = () => 18;
  expect(() => onCronTrigger(t.runtime)).toThrow("Unexpected token decimals");
  t.evm.callContract = () => ({ data: "" });
  expect(() => onCronTrigger(t.runtime)).toThrow();
});

test('named scenarios replace only market conditions and preserve real EVM balance acquisition', async () => {
  const { acquireScenarioMarket } = await import('../market-scenarios');
  const t = setup();
  HttpActionsMock.testInstance().sendRequest = () => { throw new Error('Scenario must not impersonate a live HTTP feed'); };
  const normal = acquireScenarioMarket(t.runtime, config.maker, 'normal-v1');
  const stress = acquireScenarioMarket(t.runtime, config.maker, 'stress-v1');
  expect(normal.market.volatilityBps).toBe(20);
  expect(stress.market.volatilityBps).toBe(400);
  expect(stress.market.balance0).toBe('4000000000000000');
  expect(stress.market.balance1).toBe('10000000');
  expect(stress.evidence.observation.blockNumber).toBe(HEIGHT.toString());
  expect(stress.evidence.observation.source).toBe('synthetic-scenario');
  expect(normal.evidence.inputDigest).not.toBe(stress.evidence.inputDigest);
  expect(() => acquireScenarioMarket(t.runtime, config.maker, 'caller-custom')).toThrow();
});
