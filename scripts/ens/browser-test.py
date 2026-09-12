"""Run against browser-server.mjs + separately bundled local harness, never a live wallet."""
import argparse
import json
import os
from pathlib import Path
import signal
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--api-pid', required=True, type=int)
parser.add_argument('--output', default='/tmp/pintool-ens-browser')
args = parser.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    expect.set_options(timeout=60000)
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 1000})
    page.set_default_timeout(60000)
    errors = []
    def page_error(error):
        errors.append(str(error))
        print('Browser error:', str(error), flush=True)
    page.on('pageerror', page_error)
    page.goto('http://127.0.0.1:13201')
    page.wait_for_load_state('networkidle')
    delegate = page.locator('#delegate-address').inner_text()
    if page.get_by_role('button', name='Claim Provider name', exact=True).is_visible():
        page.get_by_label('Provider label', exact=True).fill('browser-demo')
        page.get_by_role('button', name='Claim Provider name', exact=True).click()
    expect(page.get_by_text('browser-demo.pintool.eth', exact=True)).to_be_visible()
    page.get_by_role('button', name='Approve version for ENS', exact=True).click()
    expect(page.get_by_text('Version 1 approved.', exact=False)).to_be_visible()
    page.get_by_role('button', name='Publish approved version', exact=True).click()
    expect(page.get_by_text('Version 1 is discoverable', exact=False)).to_be_visible()
    page.get_by_label('Publisher wallet', exact=True).fill(delegate)
    page.get_by_role('button', name='Authorize publisher', exact=True).click()
    expect(page.get_by_text('Publisher can update', exact=False)).to_be_visible()
    name = 'eth-usdc.browser-demo.pintool.eth'
    page.get_by_label('Test role', exact=True).select_option('maker')
    page.get_by_label('Strategy name', exact=True).fill(name)
    page.get_by_role('button', name='Resolve strategy', exact=True).click()
    expect(page.get_by_role('button', name='Review this version', exact=True)).to_be_visible()
    page.get_by_role('button', name='Review this version', exact=True).click()
    assert json.loads(page.locator('#selection').inner_text())['version'] == 1
    page.screenshot(path=str(out / 'maker-v1.png'), full_page=True)

    os.kill(args.api_pid, signal.SIGUSR1)
    for _ in range(50):
        with urllib.request.urlopen('http://127.0.0.1:18788/v1/provider-strategies') as response:
            if json.load(response)['strategies'][0]['version'] == 2:
                break
        time.sleep(.1)
    page.get_by_label('Test role', exact=True).select_option('provider')
    expect(page.get_by_text('Saved publication: Browser range v2, version 2.', exact=True)).to_be_visible()
    page.get_by_role('button', name='Approve version for ENS', exact=True).click()
    expect(page.get_by_text('Version 2 approved.', exact=False)).to_be_visible()
    page.get_by_label('Test role', exact=True).select_option('delegate')
    page.get_by_label('Strategy ENS name', exact=True).fill(name)
    page.get_by_label('Version number', exact=True).fill('2')
    page.get_by_role('button', name='Publish as delegate', exact=True).click()
    expect(page.get_by_text('Published approved version 2.', exact=False)).to_be_visible()
    # The already selected Maker version is unchanged; a new lookup finds version 2.
    assert json.loads(page.locator('#selection').inner_text())['version'] == 1
    page.get_by_label('Test role', exact=True).select_option('maker')
    page.get_by_label('Strategy name', exact=True).fill(name)
    page.get_by_role('button', name='Resolve strategy', exact=True).click()
    expect(page.get_by_text('Browser range v2 · version 2', exact=True)).to_be_visible()
    page.get_by_label('Strategy name', exact=True).fill('eth-usdc.alice.evil.eth')
    page.get_by_role('button', name='Resolve strategy', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('pintool.eth')
    assert page.get_by_role('button', name='Review this version', exact=True).count() == 0

    page.get_by_label('Test role', exact=True).select_option('provider')
    page.get_by_label('Publisher wallet', exact=True).fill(delegate)
    page.get_by_role('button', name='Revoke publisher', exact=True).click()
    expect(page.get_by_text('Publisher access revoked and checked onchain.', exact=True)).to_be_visible()
    for width in [375, 768, 1280]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.screenshot(path=str(out / f'provider-{width}.png'), full_page=True)
        assert page.locator('section[aria-label="ENS strategy publishing"]').evaluate('(el) => el.scrollWidth <= el.clientWidth + 2'), f'Overflow at {width}'
    page.get_by_label('Test role', exact=True).select_option('delegate')
    page.get_by_label('Strategy ENS name', exact=True).fill(name)
    page.get_by_label('Version number', exact=True).fill('2')
    page.get_by_role('button', name='Publish as delegate', exact=True).click()
    expect(page.get_by_role('alert')).to_be_visible()
    page.screenshot(path=str(out / 'revoked-publisher.png'), full_page=True)
    assert not errors, errors
    browser.close()
print('PASS: actual Provider claim, signed manifest, ENS v1→v2, delegate write/revoke, independent Maker lookup, error recovery, 3 viewports. Local fork only.')
