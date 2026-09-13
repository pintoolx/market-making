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
  return <section className={styles.privatePanel} aria-label="私密政策編輯器">
    <div className={styles.privateHeading}><span className={styles.eyebrow}>PRIVATE POLICY</span><h3>成交條件，只在這裡設定。</h3>
      <p>依序採用第一條符合所有條件的規則；沒有符合時暫停。內容在瀏覽器加密，離開視窗就清除，不會送入策略對話。</p></div>
    {value.rules.map((rule, i) => <fieldset key={rule.id} className={styles.rule}>
      <legend>規則 {i + 1}</legend><div className={styles.ruleActions}>
        <button type="button" disabled={i === 0} aria-label={`規則 ${i + 1} 上移`} onClick={() => move(i, -1)}>↑ 上移</button>
        <button type="button" disabled={i === value.rules.length - 1} aria-label={`規則 ${i + 1} 下移`} onClick={() => move(i, 1)}>↓ 下移</button>
        <button type="button" disabled={value.rules.length === 1} aria-label={`移除規則 ${i + 1}`} onClick={() => onChange({ ...value, rules: value.rules.filter((_, n) => n !== i) })}>移除</button>
      </div><div className={styles.formGrid}>
        <label>價格下限 · {quote.symbol}/{base.symbol}<input aria-label={`規則 ${i + 1} 價格下限`} inputMode="decimal" autoComplete="off" value={rule.priceMin} onChange={e => change(i, { priceMin: e.target.value })} placeholder="不限" maxLength={80} /></label>
        <label>價格上限 · {quote.symbol}/{base.symbol}<input aria-label={`規則 ${i + 1} 價格上限`} inputMode="decimal" autoComplete="off" value={rule.priceMax} onChange={e => change(i, { priceMax: e.target.value })} placeholder="不限" maxLength={80} /></label>
        <label>波動下限 · bps<input aria-label={`規則 ${i + 1} 波動下限`} inputMode="numeric" autoComplete="off" value={rule.volatilityBpsMin} onChange={e => change(i, { volatilityBpsMin: e.target.value })} placeholder="不限" maxLength={16} /></label>
        <label>波動上限 · bps<input aria-label={`規則 ${i + 1} 波動上限`} inputMode="numeric" autoComplete="off" value={rule.volatilityBpsMax} onChange={e => change(i, { volatilityBpsMax: e.target.value })} placeholder="不限" maxLength={16} /></label>
      </div><small>上下界包含邊界；條件全部留白代表任何行情。100 bps = 1%。波動採既有 30 分鐘報酬平方和平方根計算。</small>
      <div className={styles.checks}>
        <label><input type="checkbox" checked={rule.allowMakerBuyBase} onChange={e => change(i, { allowMakerBuyBase: e.target.checked })} aria-label={`規則 ${i + 1} 允許 Maker 買入 ${base.symbol}`} />允許 Maker 買入 {base.symbol}（付出 {quote.symbol}）</label>
        <label><input type="checkbox" checked={rule.allowMakerSellBase} onChange={e => change(i, { allowMakerSellBase: e.target.checked })} aria-label={`規則 ${i + 1} 允許 Maker 賣出 ${base.symbol}`} />允許 Maker 賣出 {base.symbol}（收到 {quote.symbol}）</label>
      </div><div className={styles.formGrid}>
        <label>每筆 {base.symbol} 上限<input aria-label={`規則 ${i + 1} ${base.symbol} 單筆上限`} inputMode="decimal" autoComplete="off" value={rule.maxAmountBase} onChange={e => change(i, { maxAmountBase: e.target.value })} maxLength={80} /></label>
        <label>每筆 {quote.symbol} 上限<input aria-label={`規則 ${i + 1} ${quote.symbol} 單筆上限`} inputMode="decimal" autoComplete="off" value={rule.maxAmountQuote} onChange={e => change(i, { maxAmountQuote: e.target.value })} maxLength={80} /></label>
      </div><small>兩個 token 的上限都會檢查。任一上限為 0，或未勾選方向，此規則會暫停成交。</small>
    </fieldset>)}
    <button type="button" disabled={value.rules.length >= 8} onClick={() => onChange({ ...value, rules: [...value.rules, {
      id: 'r-' + crypto.randomUUID(), priceMin: '', priceMax: '', volatilityBpsMin: '', volatilityBpsMax: '', allowMakerBuyBase: false, allowMakerSellBase: false,
      maxAmountBase: value.rules.at(-1)!.maxAmountBase, maxAmountQuote: value.rules.at(-1)!.maxAmountQuote,
    }] })}>＋ 新增規則</button>
    <h4>私密庫存上限</h4><div className={styles.formGrid}>
      <label>成交後最多 {base.symbol}<input aria-label={`${base.symbol} 私密庫存上限`} inputMode="decimal" autoComplete="off" value={value.maxBalanceBase} onChange={e => onChange({ ...value, maxBalanceBase: e.target.value })} maxLength={80} /></label>
      <label>成交後最多 {quote.symbol}<input aria-label={`${quote.symbol} 私密庫存上限`} inputMode="decimal" autoComplete="off" value={value.maxBalanceQuote} onChange={e => onChange({ ...value, maxBalanceQuote: e.target.value })} maxLength={80} /></label>
    </div><p className={styles.helper}>事件觸發重新評估後，授權結果才會更新。Standing 授權不會只因閒置而自動到期；這些規則不保證每日累計額度或最大損失。</p>
  </section>;
}
