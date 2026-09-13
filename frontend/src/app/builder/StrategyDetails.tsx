import { formatUnits } from 'viem';
import type { StrategySpec } from '@pintool/strategy-builder';
import styles from './builder.module.css';

export default function StrategyDetails({ spec, requirements = [] }: { spec: StrategySpec; requirements?: { id: string; text: string; priority: string }[] }) {
  const model = spec.model, caps = spec.guardEnvelope, tokens = [spec.baseToken, spec.quoteToken];
  return <div className={styles.versionDetails}>
    <dl><dt>做市曲線</dt><dd>{model?.kind === 'xyc' ? '一般乘積 XYC' : model?.kind === 'pegged' ? 'Pegged 錨定曲線' : 'CLMM 固定區間'}</dd>
      {model?.kind === 'concentrated' && <><dt>{model.relativeWidthBps ? '套用時固定範圍' : '固定價格範圍'}</dt><dd>{model.relativeWidthBps ? `行情 ±${model.relativeWidthBps / 100}%` : `${model.minPrice}–${model.maxPrice}`} {spec.quoteToken?.symbol}/{spec.baseToken?.symbol}</dd></>}
      {model?.kind === 'pegged' && <><dt>參考價格／放大係數</dt><dd>{model.referencePrice} / {model.amplification}</dd></>}
      <dt>費率</dt><dd>{(spec.feeBps ?? 0) / 100}%</dd><dt>最晚策略期限</dt><dd>{spec.deadline ? new Date(spec.deadline * 1000).toLocaleString('zh-TW') : '未設定'}</dd></dl>
    <table><caption>公開 Guard 硬上限</caption><thead><tr><th>幣種</th><th>每筆交換最多</th><th>成交後庫存</th></tr></thead><tbody>{tokens.map((token, i) => token && <tr key={token.address}>
      <th scope="row">{token.symbol}</th><td>{formatUnits(BigInt((i === 0 ? caps?.maxAmountBasePerSwap : caps?.maxAmountQuotePerSwap) ?? '0'), token.decimals)}</td>
      <td>{formatUnits(BigInt((i === 0 ? caps?.maxPostBalanceBase : caps?.maxPostBalanceQuote) ?? '0'), token.decimals)}</td></tr>)}</tbody></table>
    {model?.kind === 'pegged' && <p>初始成交比例也受資產配置影響；參考價格不代表保證按該價格成交。</p>}
    {!!requirements.length && <div><h4>公開需求 · 仍需逐項驗證</h4><ul>{requirements.map(r => <li key={r.id}>{r.priority === 'must' ? '必要' : '偏好'}：{r.text}</li>)}</ul></div>}
  </div>;
}
