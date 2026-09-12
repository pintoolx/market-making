'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useConnectWallet, useWallets } from '@privy-io/react-auth';
import { createPublicClient, createWalletClient, custom, decodeEventLog, erc20Abi, formatUnits, http, parseUnits, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { isInactiveStrategyError, tradeAbi, verifiedTradeOrder, walletTakerTraits } from '../../../../shared/wallet-trade.mjs';
import deployment from '../../../../contracts/aqua-executor/deployments/11155111.json';
import { PRIVY_APP_ID } from '../providers/PrivyProvider';
import { request, type ExecutableStrategyCatalog, type ExecutableStrategy } from '../marketplace/mandateClient';
import SiteHeader from '../components/shared/SiteHeader';
import SiteFooter from '../components/shared/SiteFooter';
import Primary from '../components/shared/Primary';
import Secondary from '../components/shared/Secondary';
import FormInput from '../components/shared/FormInput';
import styles from '../marketplace/page.module.css';
import aqua from '../marketplace/aqua.module.css';
import GuardCheck from './GuardCheck';

const client = createPublicClient({ chain: sepolia, transport: http(process.env.NEXT_PUBLIC_ENS_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com', { timeout: 15000, retryCount: 1 }) });
const router = deployment.router as Hex;
const zero = BigInt(0);
const short = (s: string) => `${s.slice(0, 8)}…${s.slice(-6)}`;
type Choice = ExecutableStrategy & { maker: string; shipTransaction: Hex };
type Quote = { order: Awaited<ReturnType<typeof verifiedTradeOrder>>; strategyHash: Hex; name: string; taker: Hex; amount: bigint; output: bigint; minimum: bigint; tokenIn: Hex; tokenOut: Hex; deadline: number; allowance: bigint; balance: bigint };
type Pending = { mandateId?: string; providerStrategyId?: string; hash: Hex; kind: 'swap' | 'approval'; strategyHash: Hex; maker: string; taker: Hex; tokenIn: Hex; tokenOut: Hex; amount: string; minimum: string; name: string };
const pendingKey = 'pintool:pending-trade';

export default function Trade() {
  return <div className={`${styles.page} ${aqua.page}`}>
    <SiteHeader />
    <main className={styles.mainScroll}><div className={styles.main}>
      {PRIVY_APP_ID ? <TradeForm /> : <p>Wallet connection is not configured.</p>}
    </div></main>
    <SiteFooter />
  </div>;
}

function TradeForm() {
  const { wallets, ready } = useWallets();
  const [address, setAddress] = useState('');
  const { connectWallet } = useConnectWallet({ onSuccess: ({ wallet }) => { setAddress(wallet.address); setQuote(null); } });
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'USDC' | 'WETH'>('USDC');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failedHash, setFailedHash] = useState<Hex | null>(null);
  const [settled, setSettled] = useState<{ hash: Hex; amount: string; output: string; inputSymbol: string; outputSymbol: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [guardCheckPending, setGuardCheckPending] = useState(false);
  const [inactiveStrategy, setInactiveStrategy] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const choice = choices.find(c => c.id === selected);
  const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
  useEffect(() => {
    let alive = true;
    void request<ExecutableStrategyCatalog>('/v1/strategies').then(catalog => {
      if (!alive) return;
      const list = catalog.strategies.filter((c): c is Choice => !!c.shipTransaction && !!c.maker);
      setChoices(list);
      const requested = new URLSearchParams(window.location.search).get('strategy');
      if (list.some(c => c.id === requested)) setSelected(requested!);
      else if (requested) setError('This strategy is not available for wallet trading. Choose an available strategy below.');
      else if (list.length === 1) setSelected(list[0].id);
    }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoaded(true); });
    try { const saved = JSON.parse(localStorage.getItem(pendingKey) || 'null'); if (saved?.hash && /^0x[0-9a-f]{64}$/i.test(saved.hash)) setPending(saved); } catch { /* No saved transaction. */ }
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(tick); };
  }, []);
  const act = async (label: string, action: () => Promise<void>) => {
    setError(''); setInactiveStrategy(''); setBusy(label);
    try { await action(); } catch (e) { const message = e instanceof Error ? e.message : 'Unable to complete this request.';
      if (isInactiveStrategyError(e)) setInactiveStrategy(selected);
      setError(/StrategyNotActive|DirectionDisabled/.test(message) ? 'This strategy is not currently authorized to trade in this direction. Its Maker needs to review the execution conditions.' : /AmountLimitExceeded|InventoryLimitExceeded/.test(message) ? 'This trade exceeds the strategy’s current trade or inventory limits. Try a smaller amount.' : /rejected|denied/i.test(message) ? 'Wallet request cancelled. No new transaction was submitted.' : message); }
    finally { setBusy(''); }
  };
  const review = () => act('Checking liquidity and price…', async () => {
    setQuote(null); setSettled(null); setFailedHash(null);
    if (!choice || !wallet) throw new Error('Select a strategy and connect your trading wallet.');
    if (wallet.address.toLowerCase() === choice.maker.toLowerCase()) throw new Error('Use a separate trading wallet from this strategy’s Maker.');
    const decimals = direction === 'USDC' ? 6 : 18;
    if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(amount)) throw new Error('Enter an amount within token precision.');
    const amountIn = parseUnits(amount, decimals);
    if (amountIn <= zero || amountIn >= BigInt(2) ** BigInt(256)) throw new Error('Enter a positive amount.');
    const currentCatalog = await request<ExecutableStrategyCatalog>('/v1/strategies');
    if (!currentCatalog.strategies.some(c => c.id === choice.id && c.strategyHash === choice.strategyHash && c.shipTransaction === choice.shipTransaction)) throw new Error('This strategy is no longer available. Reload the trading page.');
    const order = await verifiedTradeOrder(client, deployment, choice);
    const block = await client.getBlock();
    if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 90) throw new Error('Market connection is stale. Please retry.');
    const taker = wallet.address as Hex;
    const tokenIn = deployment.tokens[direction] as Hex;
    const tokenOut = deployment.tokens[direction === 'USDC' ? 'WETH' : 'USDC'] as Hex;
    const [result, balance, allowance] = await Promise.all([
      client.readContract({ address: router, abi: tradeAbi, functionName: 'quote', account: taker, args: [order, tokenIn, tokenOut, amountIn, walletTakerTraits(zero)], blockNumber: block.number }),
      client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [taker], blockNumber: block.number }),
      client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [taker, router], blockNumber: block.number }),
    ]);
    if (result[0] !== amountIn || result[1] <= zero || result[2].toLowerCase() !== choice.strategyHash.toLowerCase()) throw new Error('The quote does not match this strategy.');
    if (balance < amountIn) throw new Error(`Insufficient ${direction} in your trading wallet.`);
    const minimum = result[1] * BigInt(9950) / BigInt(10000);
    if (minimum <= zero) throw new Error('The amount is too small to trade.');
    setQuote({ order, strategyHash: choice.strategyHash, name: choice.name, taker, amount: amountIn, output: result[1], minimum, tokenIn, tokenOut, deadline: Number(block.timestamp) + 300, balance, allowance });
  });
  const confirm = async (item: Pending) => {
    const [receipt, tx] = await Promise.all([client.waitForTransactionReceipt({ hash: item.hash, confirmations: 1, timeout: 120000 }), client.getTransaction({ hash: item.hash })]);
    if (receipt.status !== 'success') {
      setFailedHash(item.hash);
      localStorage.removeItem(pendingKey); setPending(null); setQuote(null);
      throw new Error('The transaction reverted. No swap settled. Review a new quote before retrying.');
    }
    if (tx.from.toLowerCase() !== item.taker.toLowerCase() || tx.to?.toLowerCase() !== (item.kind === 'swap' ? router : item.tokenIn).toLowerCase() || tx.value !== zero) throw new Error('Receipt does not match the selected wallet and contract.');
    if (item.kind === 'swap') {
      const events = receipt.logs.filter(l => l.address.toLowerCase() === router.toLowerCase()).flatMap(l => {
        try { const e = decodeEventLog({ abi: tradeAbi, data: l.data, topics: l.topics }); return e.eventName === 'Swapped' ? [e.args] : []; } catch { return []; }
      });
      const event = events.find(e => e.orderHash.toLowerCase() === item.strategyHash.toLowerCase() && e.maker.toLowerCase() === item.maker.toLowerCase() && e.taker.toLowerCase() === item.taker.toLowerCase()
        && e.tokenIn.toLowerCase() === item.tokenIn.toLowerCase() && e.tokenOut.toLowerCase() === item.tokenOut.toLowerCase() && e.amountIn === BigInt(item.amount) && e.amountOut >= BigInt(item.minimum));
      if (!event) throw new Error('No matching settlement event was found. Keep this receipt for verification.');
      const inputUsdc = item.tokenIn.toLowerCase() === deployment.tokens.USDC.toLowerCase();
      setSettled({ hash: item.hash, amount: formatUnits(event.amountIn, inputUsdc ? 6 : 18), output: formatUnits(event.amountOut, inputUsdc ? 18 : 6), inputSymbol: inputUsdc ? 'USDC' : 'WETH', outputSymbol: inputUsdc ? 'WETH' : 'USDC' });
    }
    if (item.kind === 'swap' && item.mandateId && item.providerStrategyId) {
      await request(`/v1/mandates/${item.mandateId}/executions`, { method: 'POST', body: JSON.stringify({ providerStrategyId: item.providerStrategyId, transactionHash: item.hash, outcome: 'settled' }) });
    }
    localStorage.removeItem(pendingKey); setPending(null); setQuote(null);
  };
  const sign = () => act('Review the request in your wallet…', async () => {
    if (!quote || !wallet || !choice || quote.taker.toLowerCase() !== wallet.address.toLowerCase() || quote.strategyHash !== choice.strategyHash) throw new Error('Review a quote for your current trading wallet.');
    if (Date.now() / 1000 >= quote.deadline - 15) { setQuote(null); throw new Error('Quote expired. Review a fresh price.'); }
    await wallet.switchChain(sepolia.id);
    const signer = createWalletClient({ account: quote.taker, chain: sepolia, transport: custom(await wallet.getEthereumProvider()) });
    if (await signer.getChainId() !== sepolia.id || !(await signer.getAddresses()).some(a => a.toLowerCase() === quote.taker.toLowerCase())) throw new Error('Select the reviewed trading wallet on Ethereum Sepolia.');
    const approval = quote.allowance < quote.amount;
    let hash: Hex;
    if (approval) {
      const { request: tx } = await client.simulateContract({ account: quote.taker, address: quote.tokenIn, abi: erc20Abi, functionName: 'approve', args: [router, quote.amount] });
      hash = await signer.writeContract(tx);
    } else {
      const { request: tx } = await client.simulateContract({ account: quote.taker, address: router, abi: tradeAbi, functionName: 'swap', args: [quote.order, quote.tokenIn, quote.tokenOut, quote.amount, walletTakerTraits(quote.minimum, BigInt(quote.deadline))] });
      hash = await signer.writeContract(tx);
    }
    const mandateId = new URLSearchParams(window.location.search).get('mandate');
    const item: Pending = { ...(mandateId && /^mandate-[a-f0-9-]{36}$/.test(mandateId) ? { mandateId, providerStrategyId: choice.id } : {}), hash, kind: approval ? 'approval' : 'swap', strategyHash: quote.strategyHash, maker: choice.maker, taker: quote.taker, tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amount: String(quote.amount), minimum: String(quote.minimum), name: quote.name };
    setPending(item);
    try { localStorage.setItem(pendingKey, JSON.stringify(item)); } catch { /* Receipt remains visible in memory. */ }
    setBusy('Waiting for confirmation…'); await confirm(item);
  });
  const outputSymbol = direction === 'USDC' ? 'WETH' : 'USDC';
  const expired = !!quote && now / 1000 >= quote.deadline - 15;
  return <section className={aqua.flow}>
    <Link href="/maker">← Back to strategies</Link>
    <div className={aqua.sectionTop}><div><span className={aqua.eyebrow}>Ethereum Sepolia · Aqua</span><h1>Trade with a Maker</h1><p>Get a quote from a published strategy and settle from your wallet.</p></div></div>
    <div className={aqua.decisionGrid}>
      <div className={aqua.panel}>
        <form className={aqua.tradeForm} onSubmit={e => { e.preventDefault(); void review(); }}>
          <fieldset disabled={!!busy || !!pending || guardCheckPending || !loaded || !ready}>
            <legend>Trade details</legend>
            <label>Strategy<select value={selected} onChange={e => { setSelected(e.target.value); setQuote(null); setError(''); }}><option value="">Choose a strategy</option>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Trading wallet<select value={address} onChange={e => { setAddress(e.target.value); setQuote(null); }}><option value="">Choose a wallet</option>{wallets.map(w => <option key={w.address} value={w.address}>{short(w.address)}</option>)}</select></label>
            <Secondary type="button" onClick={() => connectWallet()}>Connect trading wallet</Secondary>
            <label>Pay token<select value={direction} onChange={e => { setDirection(e.target.value as 'USDC' | 'WETH'); setQuote(null); }}><option>USDC</option><option>WETH</option></select></label><label>You pay<FormInput aria-label="Amount to pay" placeholder="0.00" inputMode="decimal" required value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} /></label>
          </fieldset>
          {!pending && <Primary type="submit" disabled={!!busy || guardCheckPending || !choice || !wallet || !amount}>{busy || 'Review quote'}</Primary>}
        </form>
        {loaded && !choices.length && <p>No wallet-activated strategies are available yet.</p>}
        {quote && <>
          <dl className={aqua.intentRows}>
            <div><dt>You receive</dt><dd>{formatUnits(quote.output, direction === 'USDC' ? 18 : 6)} {outputSymbol}</dd></div>
            <div><dt>Minimum received</dt><dd>{formatUnits(quote.minimum, direction === 'USDC' ? 18 : 6)} {outputSymbol}</dd></div>
            <div><dt>Slippage tolerance</dt><dd>0.5%</dd></div>
            <div><dt>Quote valid for</dt><dd>{expired ? 'Expired' : `${Math.max(0, Math.floor(quote.deadline - now / 1000))} seconds`}</dd></div>
          </dl>
          <Primary disabled={!!busy || !!pending || guardCheckPending || expired} onClick={() => void sign()}>{quote.allowance < quote.amount ? `Approve ${direction} in wallet` : 'Swap in wallet'}</Primary>
          {quote.allowance < quote.amount && <p>Approve only this amount, then review a fresh quote to swap.</p>}
        </>}
        {pending && <><p role="status">{pending.kind === 'swap' ? 'Swap' : 'Approval'} submitted. Check its confirmation before sending another.</p><a href={`https://sepolia.etherscan.io/tx/${pending.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a><Secondary disabled={!!busy} onClick={() => void act('Checking confirmation…', () => confirm(pending))}>Check confirmation</Secondary></>}
        {settled && <div role="status"><h2>Swap confirmed</h2><p>Paid {settled.amount} {settled.inputSymbol}<br />Received {settled.output} {settled.outputSymbol}</p><a href={`https://sepolia.etherscan.io/tx/${settled.hash}`} target="_blank" rel="noreferrer">View settlement ↗</a></div>}
        {failedHash && <a href={`https://sepolia.etherscan.io/tx/${failedHash}`} target="_blank" rel="noreferrer">View failed transaction ↗</a>}
        {busy && <p role="status">{busy}</p>}
        {error && <p role="alert" className={aqua.fieldError}>{error.length > 500 ? `${error.slice(0, 500)}…` : error}</p>}
        <GuardCheck onPendingChange={setGuardCheckPending} available={!busy && !pending && !!error && !!inactiveStrategy && inactiveStrategy === selected} choice={choice} wallet={wallet} amount={amount} direction={direction} />
      </div>
      <aside className={aqua.explanation}>
        <h2>{choice?.name || 'Direct settlement'}</h2>
        <p>The Maker supplies liquidity. You pay from your trading wallet and receive the other token in the same transaction.</p>
        <p>Guard checks authorization, trade size and inventory on every swap. A quote can become unavailable if those conditions change.</p>
        {choice && <><p>Maker <code>{short(choice.maker)}</code></p><p>Strategy <code title={choice.strategyHash}>{short(choice.strategyHash)}</code></p><a href={`https://sepolia.etherscan.io/tx/${choice.shipTransaction}`} target="_blank" rel="noreferrer">View Aqua activation ↗</a></>}
      </aside>
    </div>
  </section>;
}
