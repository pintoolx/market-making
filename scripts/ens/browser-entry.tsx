// Local Playwright harness. Bundled separately; never imported by the application.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createWalletClient, http, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import EnsWorkspace from '../../frontend/src/app/ens/EnsWorkspace';
import EnsPublisher from '../../frontend/src/app/ens/EnsPublisher';
import EnsStrategySearch from '../../frontend/src/app/ens/EnsStrategySearch';
import type { Account } from '../../frontend/src/app/providers/useAccount';
import aqua from '../../frontend/src/app/marketplace/aqua.module.css';
import styles from '../../frontend/src/app/marketplace/page.module.css';
import '../../frontend/src/app/globals.css';

if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('ENS harness is local only.');
const rpc = 'http://127.0.0.1:18546';
const accounts = ['provider', 'delegate'].map(label => privateKeyToAccount(keccak256(toBytes(`PinTool ENS browser public ${label} 20260913`))));
function Harness() {
  const [role, setRole] = useState('provider');
  const [selection, setSelection] = useState('');
  const identity = accounts[role === 'delegate' ? 1 : 0];
  const account: Account = { enabled: true, ready: true, authenticated: true, login: () => {}, address: identity.address, addresses: [identity.address], embedded: false, method: 'Local test wallet',
    signMessage: message => identity.signMessage({ message }), ensWallet: async () => createWalletClient({ account: identity, chain: sepolia, transport: http(rpc) }) };
  return <div className={`${styles.page} ${aqua.page}`}><main className={`${styles.main} ${aqua.flow}`}>
    <p>Local test harness · official ENSv2 contracts on a Sepolia fork</p>
    <label>Test role<select aria-label="Test role" value={role} onChange={e => setRole(e.target.value)}><option value="provider">Provider</option><option value="delegate">Publisher</option><option value="maker">Maker</option></select></label>
    <output id="delegate-address">{accounts[1].address}</output>
    {role === 'provider' && <EnsWorkspace key={identity.address} account={account} />}
    {role === 'delegate' && <EnsPublisher key={identity.address} account={account} />}
    {role === 'maker' && <EnsStrategySearch onSelect={value => setSelection(JSON.stringify({ name: value.name, version: value.pointer.version }))} />}
    <output id="selection">{selection}</output>
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
