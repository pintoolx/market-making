'use client';
import type { PrivatePolicyForm, PrivateRuleForm } from '@pintool/strategy-builder/private-policy';
import type { Draft } from './client';
import styles from './builder.module.css';

export default function PrivatePolicyFields({ value, onChange, draft }: { value: PrivatePolicyForm; onChange(form: PrivatePolicyForm): void; draft: Draft }) {
  const base = draft.spec.baseToken!, quote = draft.spec.quoteToken!;
  const change = (index: number, patch: Partial<PrivateRuleForm>) => onChange({ ...value, rules: value.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const move = (index: number, by: number) => {
    const rules = [...value.rules]; [rules[index], rules[index + by]] = [rules[index + by]!, rules[index]!]; onChange({ ...value, rules });
  };
  return <section className={styles.privatePanel} aria-label="Private policy editor">
    <div className={styles.privateHeading}><span className={styles.eyebrow}>Confidential execution rules</span><h3>Choose when this strategy may trade.</h3>
      <p>The first matching rule applies; no match pauses trading. Rules are encrypted in your browser and cleared when you close this dialog. They are not sent to the strategy conversation.</p></div>
    {value.rules.map((rule, i) => <fieldset key={rule.id} className={styles.rule}>
      <legend>Rule {i + 1}</legend><div className={styles.ruleActions}>
        <button type="button" disabled={i === 0} aria-label={`Rule ${i + 1} Move up`} onClick={() => move(i, -1)}>↑ Move up</button>
        <button type="button" disabled={i === value.rules.length - 1} aria-label={`Rule ${i + 1} Move down`} onClick={() => move(i, 1)}>↓ Move down</button>
        <button type="button" disabled={value.rules.length === 1} aria-label={`Remove rule ${i + 1}`} onClick={() => onChange({ ...value, rules: value.rules.filter((_, n) => n !== i) })}>Remove</button>
      </div><div className={styles.formGrid}>
        <label>Minimum price · {quote.symbol}/{base.symbol}<input aria-label={`Rule ${i + 1} Minimum price`} inputMode="decimal" autoComplete="off" value={rule.priceMin} onChange={e => change(i, { priceMin: e.target.value })} placeholder="No limit" maxLength={80} /></label>
        <label>Maximum price · {quote.symbol}/{base.symbol}<input aria-label={`Rule ${i + 1} Maximum price`} inputMode="decimal" autoComplete="off" value={rule.priceMax} onChange={e => change(i, { priceMax: e.target.value })} placeholder="No limit" maxLength={80} /></label>
        <label>Minimum volatility · bps<input aria-label={`Rule ${i + 1} Minimum volatility`} inputMode="numeric" autoComplete="off" value={rule.volatilityBpsMin} onChange={e => change(i, { volatilityBpsMin: e.target.value })} placeholder="No limit" maxLength={16} /></label>
        <label>Maximum volatility · bps<input aria-label={`Rule ${i + 1} Maximum volatility`} inputMode="numeric" autoComplete="off" value={rule.volatilityBpsMax} onChange={e => change(i, { volatilityBpsMax: e.target.value })} placeholder="No limit" maxLength={16} /></label>
      </div><small>Bounds are inclusive. Empty conditions match any market. 100 bps = 1%. Volatility uses the root sum of squared returns over 30 minutes.</small>
      <div className={styles.checks}>
        <label><input type="checkbox" checked={rule.allowMakerBuyBase} onChange={e => change(i, { allowMakerBuyBase: e.target.checked })} aria-label={`Rule ${i + 1} Allow the liquidity wallet to buy ${base.symbol}`} />Allow the liquidity wallet to buy {base.symbol} with {quote.symbol}</label>
        <label><input type="checkbox" checked={rule.allowMakerSellBase} onChange={e => change(i, { allowMakerSellBase: e.target.checked })} aria-label={`Rule ${i + 1} Allow the liquidity wallet to sell ${base.symbol}`} />Allow the liquidity wallet to sell {base.symbol} for {quote.symbol}</label>
      </div><div className={styles.formGrid}>
        <label>Per-swap {base.symbol} limit<input aria-label={`Rule ${i + 1} ${base.symbol} per-swap limit`} inputMode="decimal" autoComplete="off" value={rule.maxAmountBase} onChange={e => change(i, { maxAmountBase: e.target.value })} maxLength={80} /></label>
        <label>Per-swap {quote.symbol} limit<input aria-label={`Rule ${i + 1} ${quote.symbol} per-swap limit`} inputMode="decimal" autoComplete="off" value={rule.maxAmountQuote} onChange={e => change(i, { maxAmountQuote: e.target.value })} maxLength={80} /></label>
      </div><small>Both token limits are checked. A zero limit or no selected direction pauses trading under this rule.</small>
    </fieldset>)}
    <button type="button" disabled={value.rules.length >= 8} onClick={() => onChange({ ...value, rules: [...value.rules, {
      id: 'r-' + crypto.randomUUID(), priceMin: '', priceMax: '', volatilityBpsMin: '', volatilityBpsMax: '', allowMakerBuyBase: false, allowMakerSellBase: false,
      maxAmountBase: value.rules.at(-1)!.maxAmountBase, maxAmountQuote: value.rules.at(-1)!.maxAmountQuote,
    }] })}>+ Add rule</button>
    <h4>Private inventory limits</h4><div className={styles.formGrid}>
      <label>Maximum after swap {base.symbol}<input aria-label={`${base.symbol} Private inventory limits`} inputMode="decimal" autoComplete="off" value={value.maxBalanceBase} onChange={e => onChange({ ...value, maxBalanceBase: e.target.value })} maxLength={80} /></label>
      <label>Maximum after swap {quote.symbol}<input aria-label={`${quote.symbol} Private inventory limits`} inputMode="decimal" autoComplete="off" value={value.maxBalanceQuote} onChange={e => onChange({ ...value, maxBalanceQuote: e.target.value })} maxLength={80} /></label>
    </div><p className={styles.helper}>PinTool updates authorization when a monitored condition changes. These rules cap individual swaps and inventory; they do not enforce a daily loss limit.</p>
  </section>;
}
