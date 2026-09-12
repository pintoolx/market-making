import { mkdir, writeFile, copyFile } from 'node:fs/promises';
const outdir = '.cache/ens-browser';
await mkdir(outdir, { recursive: true });
const build = await Bun.build({ entrypoints: ['scripts/ens/browser-entry.tsx'], outdir, target: 'browser', external: ['/hero.svg'],
  define: { 'process.env.NEXT_PUBLIC_MANDATE_API_URL': JSON.stringify('http://127.0.0.1:18788'), 'process.env.NEXT_PUBLIC_ENS_SEPOLIA_RPC_URL': JSON.stringify('http://127.0.0.1:18546'), 'process.env.NODE_ENV': JSON.stringify('development') },
  plugins: [{ name: 'isolated-next-link', setup(builder) { builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: new URL('./browser-link.tsx', import.meta.url).pathname })); } }],
});
if (!build.success) { for (const log of build.logs) console.error(log); process.exit(1); }
await writeFile(`${outdir}/index.html`, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="browser-entry.css"><title>PinTool ENS integration test</title></head><body><div id="root"></div><script src="browser-entry.js"></script></body></html>');
await copyFile('frontend/public/hero.svg', `${outdir}/hero.svg`);
console.log('Built local ENS browser harness.');
