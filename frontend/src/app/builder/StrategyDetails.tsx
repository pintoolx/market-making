import { formatUnits } from 'viem';
import type { StrategySpec } from '@pintool/strategy-builder';
import styles from './builder.module.css';

export default function StrategyDetails({ spec, requirements = [] }: { spec: StrategySpec; requirements?: { id: string; text: string; priority: string }[] }) {
  const model = spec.model, caps = spec.guardEnvelope, tokens = [spec.baseToken, spec.quoteToken];
  return <div className={styles.versionDetails}>
    <dl><dt>Market-making curve</dt><dd>{model?.kind === 'xyc' ? 'Constant product XYC' : model?.kind === 'pegged' ? 'Pegged curve' : 'Fixed-range CLMM'}</dd>
      {model?.kind === 'concentrated' && <><dt>{model.relativeWidthBps ? 'Range fixed at application' : 'Fixed price range'}</dt><dd>{model.relativeWidthBps ? `Market price ±${model.relativeWidthBps / 100}%` : `${model.minPrice}–${model.maxPrice}`} {spec.quoteToken?.symbol}/{spec.baseToken?.symbol}</dd></>}
      {model?.kind === 'pegged' && <><dt>Reference price / amplification</dt><dd>{model.referencePrice} / {model.amplification}</dd></>}
      <dt>Fee</dt><dd>{(spec.feeBps ?? 0) / 100}%</dd><dt>Latest strategy deadline</dt><dd>{spec.deadline ? new Date(spec.deadline * 1000).toLocaleString('en-US') : 'Not set'}</dd></dl>
    <table><caption>Public swap limits</caption><thead><tr><th>Token</th><th>Maximum per swap</th><th>Post-swap inventory</th></tr></thead><tbody>{tokens.map((token, i) => token && <tr key={token.address}>
      <th scope="row">{token.symbol}</th><td>{formatUnits(BigInt((i === 0 ? caps?.maxAmountBasePerSwap : caps?.maxAmountQuotePerSwap) ?? '0'), token.decimals)}</td>
      <td>{formatUnits(BigInt((i === 0 ? caps?.maxPostBalanceBase : caps?.maxPostBalanceQuote) ?? '0'), token.decimals)}</td></tr>)}</tbody></table>
    {model?.kind === 'pegged' && <p>Initial execution prices also depend on allocations. The reference price is not a guaranteed fill price.</p>}
    {!!requirements.length && <div><h4>Public requirements · Individual verification required</h4><ul>{requirements.map(r => <li key={r.id}>{r.priority === 'must' ? 'Required' : 'Preference'}: {r.text}</li>)}</ul></div>}
  </div>;
}
