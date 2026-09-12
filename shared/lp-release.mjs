// Shared by the browser, registry and executor. Only PUBLIC execution parameters belong here.
export const LP_CAPABILITIES = Object.freeze({
  clmm: { publication: true, curve: 'concentrated', feeBps: 0, modifiers: [], signal: 'rss-simple-returns-30m-v1' },
  xyc: { publication: false, reason: 'Guarded fee mapping is pending.' },
  pegged: { publication: false, reason: 'Reference and spread mapping is pending.' },
  decay: { publication: false, reason: 'Native decay period integration is pending.' },
  inventory: { publication: false, reason: 'Target inventory control is pending.' },
  shared: { publication: false, reason: 'Capital allocation control is pending.' },
});

const exact = (v, keys) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error('Unexpected release fields');
};
const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const amount = v => typeof v === 'string' && /^[1-9][0-9]{0,38}$/.test(v) && BigInt(v) < 2n ** 128n;
export function parseRelease(value) {
  exact(value, ['schema', 'id', 'version', 'provider', 'name', 'summary', 'state', 'execution']);
  const { schema, id, version, provider, name, summary, state, execution: e } = value;
  if (schema !== 'pintool-lp-release-v1' || !/^0x[0-9a-f]{40}$/.test(provider ?? '') || /^0x0{40}$/.test(provider)
    || id !== `${provider.slice(2)}-clmm` || !integer(version, 1, 1000000)
    || typeof name !== 'string' || !name.trim() || name.length > 80 || typeof summary !== 'string' || !summary.trim() || summary.length > 600
    || !['published', 'withdrawn'].includes(state)) throw new Error('Invalid release identity or listing');
  exact(e, ['curve', 'chainId', 'pair', 'feeBps', 'rangeBelowBps', 'rangeAboveBps', 'maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1', 'ttlSec']);
  if (e.curve !== 'concentrated' || e.chainId !== 11155111 || e.pair !== 'WETH/USDC' || e.feeBps !== 0
    || !integer(e.rangeBelowBps, 1, 9999) || !integer(e.rangeAboveBps, 1, 100000)
    || !integer(e.ttlSec, 1, 600) || !['maxAmount0PerSwap', 'maxAmount1PerSwap', 'maxPostBalance0', 'maxPostBalance1'].every(k => amount(e[k]))
    || BigInt(e.maxAmount0PerSwap) > BigInt(e.maxPostBalance0) || BigInt(e.maxAmount1PerSwap) > BigInt(e.maxPostBalance1)) throw new Error('Unsupported CLMM execution parameters');
  return { schema, id, version, provider, name, summary, state, execution: {
    curve: e.curve, chainId: e.chainId, pair: e.pair, feeBps: e.feeBps,
    rangeBelowBps: e.rangeBelowBps, rangeAboveBps: e.rangeAboveBps,
    maxAmount0PerSwap: e.maxAmount0PerSwap, maxAmount1PerSwap: e.maxAmount1PerSwap,
    maxPostBalance0: e.maxPostBalance0, maxPostBalance1: e.maxPostBalance1, ttlSec: e.ttlSec,
  } };
}

export function parseEnvelope(value) {
  exact(value, ['version', 'ephemeralPublicKey', 'nonce', 'ciphertext']);
  if (value.version !== 1 || !/^[0-9a-f]{64}$/i.test(value.ephemeralPublicKey ?? '') || !/^[0-9a-f]{48}$/i.test(value.nonce ?? '')
    || typeof value.ciphertext !== 'string' || !/^(?:[0-9a-f]{2}){16,4096}$/i.test(value.ciphertext)) throw new Error('Invalid encrypted policy');
  return { version: 1, ephemeralPublicKey: value.ephemeralPublicKey, nonce: value.nonce, ciphertext: value.ciphertext };
}

// Signed ciphertext prevents the registry from substituting another policy for this version.
export function publicationMessage(release, envelope) {
  return 'PinTool Provider publication v1\n' + JSON.stringify({ release: parseRelease(release), envelope: parseEnvelope(envelope) });
}

export function percentToBps(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,2})?$/.test(value)) throw new Error('Percentages need at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function providerPolicy(release, volatilityBpsMax) {
  const r = parseRelease(release), e = r.execution;
  if (!integer(volatilityBpsMax, 0, 100000)) throw new Error('Invalid 30-minute volatility threshold');
  return { schemaVersion: 1, strategyId: `${r.id}.v${r.version}`, rules: [{
    id: 'below-volatility-limit', when: { volatilityBpsMax }, allowMakerBuyToken0: true, allowMakerSellToken0: true,
    maxAmount0PerSwap: e.maxAmount0PerSwap, maxAmount1PerSwap: e.maxAmount1PerSwap, ttlSec: e.ttlSec,
  }], inventory: { maxBalance0: e.maxPostBalance0, maxBalance1: e.maxPostBalance1 } };
}
