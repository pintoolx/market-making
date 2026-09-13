"""Real browser/API/Postgres acceptance with a deterministic model and local wallet.

Run against test/browser/server.mjs only. No production identity, model key, or chain writes.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

artifacts = Path('.cache/builder')
artifacts.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:3311')
    page.wait_for_load_state('networkidle')
    page.screenshot(path=str(artifacts / 'browser-welcome.png'), full_page=True)
    expect(page.get_by_role('heading', name='Turn your idea into a strategy.')).to_be_visible()
    page.get_by_role('button', name='Verify wallet and start designing').click()
    composer = page.get_by_label('Describe your goals or what you want to change')
    expect(composer).to_be_enabled()
    summary = page.get_by_role('complementary', name='Current strategy')

    def send(text):
        composer.fill(text)
        page.get_by_role('button', name='Send ↗').click()

    def finished(revision):
        expect(page.get_by_text(f'Saved · v{revision}', exact=True)).to_be_visible(timeout=20000)
        expect(page.get_by_role('button', name='Stop generating')).to_have_count(0, timeout=20000)
        expect(page.get_by_role('alert')).to_have_count(0)

    def caps_unchanged():
        expect(summary.get_by_role('row', name='WETH 0.05 2', exact=True)).to_be_visible()
        expect(summary.get_by_role('row', name='USDC 125 5000', exact=True)).to_be_visible()

    send('Create WETH / USDC with a fixed range of 2200 to 2800, zero fees, per-swap limits of 0.05 WETH / 125 USDC and inventory limits of 2 WETH / 5000 USDC.')
    # A short response may complete between UI polling cycles. The deliberately
    # slow turn below verifies the intermediate streaming state before cancellation.
    finished(2)
    expect(summary.get_by_text('Public parameters complete', exact=True)).to_be_visible()
    caps_unchanged()
    page.screenshot(path=str(artifacts / 'browser-desktop.png'), full_page=True)

    send('Change only the maximum price to 2700 and preserve other limits.')
    finished(3)
    expect(summary.get_by_text('2700', exact=True)).to_be_visible()
    caps_unchanged()

    page.get_by_role('button', name=re.compile('Versions and changes')).click()
    # The nearest version row owns exactly one restore button.
    summary.get_by_text('v2', exact=True).locator('..').get_by_role('button', name='Restore this revision').click()
    finished(4)
    expect(summary.get_by_text('2800', exact=True)).to_be_visible()
    caps_unchanged()
    page.get_by_role('button', name=re.compile('Versions and changes')).click()

    send('Slowly compare the risks without changing settings.')
    expect(page.locator('article[aria-busy="true"]')).to_be_visible(timeout=15000)
    page.get_by_role('button', name='Stop generating').click()
    finished(4)
    expect(page.locator('article[aria-busy="true"]')).to_have_count(0)
    caps_unchanged()

    # A committed request with a lost response must resume, not create a duplicate turn.
    def lose_acceptance(route):
        if route.request.method == 'POST':
            response = route.fetch()
            assert response.status == 202
            route.abort('connectionfailed')
        else:
            route.continue_()
    page.route('**/conversations/*/turns', lose_acceptance, times=1)
    lost = 'Slowly explain the existing strategy without changes; test reconnection.'
    send(lost)
    expect(page.get_by_role('alert')).to_be_visible(timeout=10000)
    page.get_by_role('button', name='Reload').click()
    expect(page.get_by_role('alert')).to_have_count(0)
    expect(page.get_by_role('button', name='Stop generating')).to_be_visible()
    page.get_by_role('button', name='Stop generating').click()
    finished(4)
    expect(page.locator('article').get_by_text(lost, exact=True)).to_have_count(1)
    expect(composer).to_have_value('')

    page.reload()
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='Verify wallet and start designing').click()
    finished(4)
    caps_unchanged()
    expect(page.locator('article').get_by_text(lost, exact=True)).to_have_count(1)

    # Session expiry returns to wallet proof without stranding the user in a reload loop.
    page.route('**/turns/*/events?*', lambda route: route.fulfill(status=401, json={'error': 'authentication-required'}), times=1)
    send('Slowly analyze without changing settings. Test session expiry.')
    expect(page.get_by_role('button', name='Verify wallet and start designing')).to_be_visible()
    page.get_by_role('button', name='Verify wallet and start designing').click()
    expect(page.get_by_role('button', name='Stop generating')).to_be_visible()
    page.get_by_role('button', name='Stop generating').click()
    finished(4)

    page.set_viewport_size({'width': 390, 'height': 844})
    expect(composer).to_be_enabled()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow on mobile'
    composer.scroll_into_view_if_needed()
    page.screenshot(path=str(artifacts / 'browser-mobile.png'), full_page=True)
    bottom = page.get_by_role('button', name=re.compile('Versions and changes'))
    bottom.scroll_into_view_if_needed()
    expect(bottom).to_be_in_viewport()
    page.screenshot(path=str(artifacts / 'browser-mobile-summary.png'), full_page=True)
    heading = page.get_by_role('heading', name='Turn your idea into a strategy.')
    heading.scroll_into_view_if_needed()
    expect(heading).to_be_in_viewport()
    page.get_by_role('button', name='+ New draft').click()
    expect(page.get_by_text('Saved · v1', exact=True)).to_be_visible()
    send('Single field: save only the WETH limit of 0.05; other fields remain undecided.')
    finished(2)
    expect(summary.get_by_role('row', name='WETH 0.05 Not set', exact=True)).to_be_visible()
    expect(summary.get_by_role('row', name='USDC Not set Not set', exact=True)).to_be_visible()
    expect(summary.get_by_text('Quote-token limit per swap', exact=True)).to_be_visible()
    expect(summary.get_by_text('Public parameters complete', exact=True)).to_have_count(0)
    assert not errors, errors
    print('PASS: wallet proof, streaming, CLMM edits/caps, restore, cancel, lost-response recovery, reload, session expiry, mobile, partial limits; no page errors')
    browser.close()
