import React from 'react';
import { createRoot } from 'react-dom/client';
import { privateKeyToAccount } from 'viem/accounts';
import BuilderWorkspace from '../../../../frontend/src/app/builder/BuilderWorkspace';
import '../../../../frontend/src/app/globals.css';
import layout from '../../../../frontend/src/app/marketplace/page.module.css';
import aqua from '../../../../frontend/src/app/marketplace/aqua.module.css';

// Public local fixture identity. This file is only bundled into ignored test artifacts.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
window.__fixtureSignedMessages = [];
const identity = { enabled: true, ready: true, authenticated: true, userId: 'did:privy:browser', address: account.address,
  login() {}, signMessage: message => { window.__fixtureSignedMessages.push(message); return account.signMessage({ message }); },
  getAccessToken: async () => (await (await fetch('/fixture/token')).json()).token,
};
createRoot(document.getElementById('root')).render(<div className={`${layout.page} ${aqua.page}`}>
  <main className={layout.mainScroll}><div className={layout.main}><BuilderWorkspace identity={identity} /></div></main>
</div>);
