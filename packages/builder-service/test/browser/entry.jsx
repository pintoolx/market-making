import React from 'react';
import { createRoot } from 'react-dom/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import BuilderWorkspace from '../../../../frontend/src/app/builder/BuilderWorkspace';
import '../../../../frontend/src/app/globals.css';
import layout from '../../../../frontend/src/app/marketplace/page.module.css';
import aqua from '../../../../frontend/src/app/marketplace/aqua.module.css';

// Public local fixture identity. This file is only bundled into ignored test artifacts.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
window.__fixtureSignedMessages = [];
const identity = { enabled: true, ready: true, authenticated: true, userId: 'did:privy:browser', address: account.address,
  evmWallet: async () => {
    const { rpcUrl } = await (await fetch('/fixture/wallet')).json();
    if (new URL(rpcUrl).hostname !== '127.0.0.1') throw new Error('Only an owned localhost fork is allowed');
    const client = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) }), send = client.sendTransaction;
    client.sendTransaction = async request => {
      if (window.__fixtureRejectWallet) { window.__fixtureRejectWallet = false; throw Object.assign(new Error('Fixture wallet rejected'), { code: 4001 }); }
      const hash = await send(request);
      if (window.__fixtureLoseHash) { window.__fixtureLoseHash = false; throw new Error('Fixture wallet response lost after send'); }
      return hash;
    };
    return client;
  },
  login() {}, signMessage: message => { window.__fixtureSignedMessages.push(message); return account.signMessage({ message }); },
  getAccessToken: async () => (await (await fetch('/fixture/token')).json()).token,
};
createRoot(document.getElementById('root')).render(<div className={`${layout.page} ${aqua.page}`}>
  <main className={layout.mainScroll}><div className={layout.main}><BuilderWorkspace identity={identity} /></div></main>
</div>);
