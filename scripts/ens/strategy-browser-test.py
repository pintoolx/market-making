"""Read-only browser regression against a named published CLMM fixture. Requires Python Playwright.

Serve a production frontend export with Wrangler Pages. The API proxy retains the
configured API Origin and permits GET only; no application writes or wallet
transactions are submitted. Use a current named version visible in the marketplace.
"""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlencode
from playwright.async_api import async_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:13221')
parser.add_argument('--provider', required=True)
parser.add_argument('--provider-name', required=True)
parser.add_argument('--ens', required=True)
parser.add_argument('--title', required=True)
parser.add_argument('--version', type=int, default=1)
parser.add_argument('--api-origin', default='https://mm.pintool.fun')
args = parser.parse_args()
base = args.base
provider = args.provider.lower()
provider_name = args.provider_name
ens = args.ens
strategy_id = provider[2:] + f'-clmm.v{args.version}'
permalink = '/strategy?' + urlencode({'id': strategy_id, 'ens': ens})
out = Path('/tmp/pintool-strategy-browser')
out.mkdir(exist_ok=True)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1280, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
        errors = []
        reads = []
        async def api(route):
            if route.request.method == 'OPTIONS':
                await route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, OPTIONS'})
                return
            assert route.request.method == 'GET', 'Browser verification must never submit application transactions'
            reads.append(route.request.url)
            response = await route.fetch(headers={**route.request.headers, 'origin': args.api_origin})
            await route.fulfill(response=response, headers={**response.headers, 'access-control-allow-origin': '*'})
        await context.route('**/v1/**', api)
        page = await context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: print('BROWSER', message.text, flush=True) if message.type == 'error' else None)
        page.set_default_timeout(60000)
        async def goto(path):
            await page.goto(base + path)
            await page.wait_for_load_state('networkidle')
        async def details():
            await expect(page.get_by_role('heading', name=args.title, level=1, exact=True)).to_be_visible()
            await expect(page.get_by_text('by ' + provider_name, exact=True)).to_be_visible(timeout=90000)
            await expect(page.get_by_text(ens, exact=True)).to_be_visible(timeout=90000)
            await expect(page.get_by_text(f'Version {args.version}', exact=True)).to_be_visible()
            assert strategy_id in page.url
        await goto('/studio')
        await page.get_by_role('link', name='Liquidity', exact=True).click()
        await expect(page.get_by_role('heading', name='Available strategies', exact=True)).to_be_visible()
        card = page.locator('article').filter(has=page.get_by_role('heading', name=args.title, exact=True))
        await expect(card.get_by_text('by ' + provider_name, exact=True)).to_be_visible(timeout=90000)
        await expect(card.get_by_text(ens, exact=True)).to_be_visible(timeout=90000)
        card_href = await card.get_by_role('link', name='View strategy', exact=True).get_attribute('href')
        await card.get_by_role('button', name='Copy address ' + provider, exact=True).click()
        assert await page.evaluate('navigator.clipboard.readText()') == provider
        await card.get_by_role('link', name='View strategy', exact=True).click()
        await page.wait_for_url('**/strategy?**')
        await details()
        assert len(context.pages) == 1
        await page.get_by_role('button', name='Copy strategy link', exact=True).click()
        copied = await page.evaluate('navigator.clipboard.readText()')
        assert copied == page.url
        await page.reload()
        await details()
        print('PASS: Provider + strategy ENS on card and detail; same-tab navigation; address/link copy and refresh retain the selected version', flush=True)
        await page.go_back()
        await expect(page.get_by_role('heading', name='Available strategies', exact=True)).to_be_visible()
        assert page.url == base + '/maker'
        await page.go_forward()
        await details()
        await page.get_by_role('link', name='← Strategy marketplace', exact=True).click()
        await expect(page.get_by_role('heading', name='Available strategies', exact=True)).to_be_visible()
        await page.get_by_label('Strategy name', exact=True).fill(ens)
        await page.get_by_role('button', name='Resolve strategy', exact=True).click()
        review = page.get_by_role('link', name='Review this version', exact=True)
        await expect(review).to_be_visible(timeout=90000)
        assert await review.get_attribute('href') == card_href
        await review.click()
        await details()
        await page.go_back()
        await expect(page.get_by_label('Strategy name', exact=True)).to_have_value(ens)
        await expect(page.get_by_role('link', name='Review this version', exact=True)).to_be_visible(timeout=90000)
        print('PASS: browser back/forward and in-page return work; ENS search uses the same detail link and restores the query', flush=True)
        await goto('/maker?' + urlencode({'strategy': strategy_id}))
        await page.wait_for_url('**/strategy?**')
        await details()
        await goto('/strategy?' + urlencode({'ens': ens}))
        await details()
        print('PASS: existing version deep links and ENS-only aliases resolve to versioned detail URLs', flush=True)
        for width in [375, 1280]:
            await page.set_viewport_size({'width': width, 'height': 1000})
            assert await page.locator('main').evaluate('(el) => el.scrollWidth <= el.clientWidth + 2'), f'Horizontal overflow at {width}'
            await page.screenshot(path=str(out / f'detail-{width}.png'), full_page=True)
        await goto('/maker?' + urlencode({'strategy': strategy_id, 'start': '1', 'ens': ens}))
        await expect(page.get_by_role('heading', name='Enable liquidity from your wallet.', exact=True)).to_be_visible(timeout=90000)
        await expect(page.get_by_role('button', name='Connect Maker wallet', exact=True)).to_be_visible()
        assert 'start=1' in page.url and strategy_id in page.url
        print('PASS: exact version + verified ENS pass into Maker activation without requesting a wallet transaction', flush=True)
        await goto('/strategy?id=not-a-strategy')
        await expect(page.locator('main').get_by_role('alert')).to_contain_text('could not be found')
        await goto(permalink)
        await details()
        await page.evaluate("history.pushState(null, '', '/strategy?id=featured-wide-range')")
        await expect(page.get_by_role('heading', name='Wide Range Reserve', level=1, exact=True)).to_be_visible()
        assert await page.get_by_text(ens, exact=True).count() == 0
        print('PASS: invalid links fail visibly; changing the URL replaces the detail identity', flush=True)
        assert not errors, errors
        await context.close()
        fresh = await browser.new_context()
        await fresh.route('**/v1/**', api)
        direct = await fresh.new_page()
        await direct.goto(copied)
        await expect(direct.get_by_role('heading', name=args.title, level=1, exact=True)).to_be_visible(timeout=60000)
        await expect(direct.get_by_text(ens, exact=True)).to_be_visible(timeout=90000)
        print('PASS: copied strategy URL opens in a fresh browser session without login or local state', flush=True)
        await fresh.close()
        await browser.close()
        (out / 'result.json').write_text(json.dumps({'result': 'pass', 'copyUrl': copied, 'apiReadCount': len(reads), 'browserErrors': errors}, indent=2))

asyncio.run(main())
