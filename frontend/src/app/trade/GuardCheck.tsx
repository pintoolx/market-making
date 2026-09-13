'use client';

import { useEffect, useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi, http, parseUnits, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { isInactiveStrategyError, tradeAbi, verifiedTradeOrder, walletErrorMessage, walletTakerTraits } from '../../../../shared/wallet-trade.mjs';
import deployment from '../../../../contracts/aqua-executor/deployments/11155111.json';
import { request, type ExecutableStrategy } from '../marketplace/mandateClient';
import Secondary from '../components/shared/Secondary';
import Primary from '../components/shared/Primary';
import FormInput from '../components/shared/FormInput';

const client = createPublicClient({ chain: sepolia, transport: http(process.env.NEXT_PUBLIC_ENS_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com', { timeout: 15000, retryCount: 1 }) });
const router = deployment.router as Hex;
const pendingKey = 'pintool:pending-guard-check';
type PendingCheck = { hash: Hex; data: Hex; taker: Hex; mandateId?: string; listingId: string; approvalToken?: Hex };
type Props = { onPendingChange: (locked: boolean) => void; available: boolean; choice?: ExecutableStrategy & { maker: string; shipTransaction: Hex }; wallet?: ReturnType<typeof useWallets>['wallets'][number]; amount: string; direction: 'USDC' | 'WETH' };

export default function GuardCheck({ onPendingChange, available, choice, wallet, amount, direction }: Props) {
  const choiceId = choice?.id;
  const walletAddress = wallet?.address;
  const [minimum, setMinimum] = useState('');
  const [pending, setPending] = useState<PendingCheck | null>(null);
  const [completed, setCompleted] = useState<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [allowanceReady, setAllowanceReady] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    setAllowanceReady(null);
    if (!available || !choiceId || !walletAddress) return () => { current = false; };
    const decimals = direction === 'USDC' ? 6 : 18;
    if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(amount)) return () => { current = false; };
    const amountIn = parseUnits(amount, decimals);
    if (amountIn <= BigInt(0)) return () => { current = false; };
    const tokenIn = deployment.tokens[direction] as Hex;
    client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [walletAddress as Hex, router] })
      .then(value => { if (current) setAllowanceReady(value >= amountIn); })
      .catch(() => { if (current) setAllowanceReady(null); });
    return () => { current = false; };
  }, [available, choiceId, walletAddress, amount, direction]);
  useEffect(() => { onPendingChange(busy || !!pending); }, [busy, pending, onPendingChange]);
  useEffect(() => { setCompleted(null); }, [choice?.id]);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(pendingKey) || 'null'); if (/^0x[0-9a-f]{64}$/i.test(saved?.hash ?? '')) setPending(saved); } catch { /* No saved check. */ } }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await fn(); } catch (e) { setMessage(walletErrorMessage(e)); }
    finally { setBusy(false); }
  };
  const confirm = async (item: PendingCheck) => {
    const [receipt, tx] = await Promise.all([client.waitForTransactionReceipt({ hash: item.hash, timeout: 120000 }), client.getTransaction({ hash: item.hash })]);
    if (tx.from.toLowerCase() !== item.taker.toLowerCase() || tx.to?.toLowerCase() !== (item.approvalToken ?? router).toLowerCase() || tx.input !== item.data || tx.value !== BigInt(0)) throw new Error('The receipt does not match the reviewed request.');
    if (item.approvalToken) {
      setPending(null); setAllowanceReady(true);
      try { localStorage.removeItem(pendingKey); } catch { /* The receipt remains in the wallet. */ }
      if (receipt.status !== 'success') throw new Error('Token approval reverted. No verification trade was submitted.');
      setMessage('Approval confirmed. Submit the blocked swap to create the rejection receipt.');
      return;
    }
    if (receipt.status === 'success') throw new Error('The transaction succeeded after authorization changed. Open its receipt to inspect the settlement; this is not a rejection.');
    if (receipt.logs.length) throw new Error('Unexpected events in a reverted transaction.');
    if (item.mandateId) await request(`/v1/mandates/${item.mandateId}/executions`, { method: 'POST', body: JSON.stringify({ providerStrategyId: item.listingId, transactionHash: item.hash, outcome: 'rejected' }) });
    setCompleted(item.hash); setPending(null);
    try { localStorage.removeItem(pendingKey); } catch { /* The receipt remains visible. */ }
  };
  const submit = () => act(async () => {
    if (!choice || !wallet || !available) throw new Error('Review the inactive strategy with your trading wallet first.');
    if (choice.maker.toLowerCase() === wallet.address.toLowerCase()) throw new Error('Use the Taker wallet.');
    const inputDecimals = direction === 'USDC' ? 6 : 18, outputDecimals = direction === 'USDC' ? 18 : 6;
    if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${inputDecimals}})?$`).test(amount) || !new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${outputDecimals}})?$`).test(minimum)) throw new Error('Enter valid payment and minimum received amounts.');
    const amountIn = parseUnits(amount, inputDecimals), minOut = parseUnits(minimum, outputDecimals);
    if (amountIn <= BigInt(0) || minOut <= BigInt(0) || amountIn >= BigInt(2) ** BigInt(256) || minOut >= BigInt(2) ** BigInt(256)) throw new Error('Both amounts must be positive and within token limits.');
    const taker = wallet.address as Hex;
    const order = await verifiedTradeOrder(client, deployment, choice);
    const tokenIn = deployment.tokens[direction] as Hex, tokenOut = deployment.tokens[direction === 'USDC' ? 'WETH' : 'USDC'] as Hex;
    const [block, balance, allowance] = await Promise.all([client.getBlock(),
      client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [taker] }),
      client.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [taker, router] })]);
    if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 90) throw new Error('Chain connection is stale. Retry before signing.');
    if (balance < amountIn) throw new Error('The trading wallet needs sufficient balance for this request.');
    const args = [order, tokenIn, tokenOut, amountIn, walletTakerTraits(minOut, block.timestamp + BigInt(300))] as const;
    let inactive = false;
    try { await client.simulateContract({ account: taker, address: router, abi: tradeAbi, functionName: 'swap', args }); }
    catch (e) { if (!isInactiveStrategyError(e)) throw new Error('Preflight did not return StrategyNotActive. Review the strategy before submitting.'); inactive = true; }
    if (!inactive) throw new Error('The strategy is now executable. Use a normal quote to trade.');
    const approve = allowance < amountIn;
    await wallet.switchChain(sepolia.id);
    const signer = createWalletClient({ account: taker, chain: sepolia, transport: custom(await wallet.getEthereumProvider()) });
    if (await signer.getChainId() !== sepolia.id || !(await signer.getAddresses()).some(a => a.toLowerCase() === taker.toLowerCase())) throw new Error('Select the reviewed Taker on Ethereum Sepolia.');
    let hash: Hex, data: Hex;
    if (approve) {
      const { request: tx } = await client.simulateContract({ account: taker, address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [router, amountIn] });
      hash = await signer.writeContract(tx);
      data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, amountIn] });
    } else {
      hash = await signer.writeContract({ address: router, abi: tradeAbi, functionName: 'swap', args, gas: BigInt(400000) });
      data = encodeFunctionData({ abi: tradeAbi, functionName: 'swap', args });
    }
    const mandateId = new URLSearchParams(window.location.search).get('mandate');
    const item: PendingCheck = { hash, data, taker, listingId: choice.id, ...(approve ? { approvalToken: tokenIn } : {}),
      ...(mandateId && /^mandate-[a-f0-9-]{36}$/.test(mandateId) ? { mandateId } : {}) };
    setPending(item);
    try { localStorage.setItem(pendingKey, JSON.stringify(item)); } catch { /* The pending receipt remains visible. */ }
    await confirm(item);
  });
  if (!available && !pending && !completed) return null;
  return <details open={!!pending || !!completed}>
    <summary>Advanced · Verify a blocked swap</summary>
    <p>Submit the blocked request on Sepolia to create a public rejection receipt.</p>
    {!pending && !completed && <>
      <label>Minimum received ({direction === 'USDC' ? 'WETH' : 'USDC'})<FormInput aria-label="Minimum received for verification" inputMode="decimal" value={minimum} onChange={e => setMinimum(e.target.value)} disabled={busy} /></label>
      <Primary fullWidth disabled={busy || !minimum} onClick={() => void submit()}>{allowanceReady === false ? `Approve ${direction} in wallet` : allowanceReady === true ? 'Submit blocked swap' : 'Continue in wallet'}</Primary>
    </>}
    {pending && <><p role="status">{pending.approvalToken ? 'Token approval' : 'Verification transaction'} submitted.</p><a href={`https://sepolia.etherscan.io/tx/${pending.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a><Secondary fullWidth disabled={busy} onClick={() => void act(() => confirm(pending))}>Check receipt</Secondary></>}
    {completed && <p role="status">Transaction reverted; no tokens moved. <a href={`https://sepolia.etherscan.io/tx/${completed}`} target="_blank" rel="noreferrer">View failed transaction ↗</a></p>}
    {busy && <p role="status">Waiting for wallet or chain confirmation…</p>}
    {message && <p role="alert">{message}</p>}
  </details>;
}
