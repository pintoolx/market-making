"""Run after templates.py against its fresh fixture. Mock inventory/worker, real UI/API/PG/compiler."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

artifacts = Path('.cache/builder')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors, sent = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: sent.append({'url': r.url, 'body': r.post_data or '', 'key': r.headers.get('idempotency-key')}) if '/v1/builder/' in r.url else None)
    def connect_maker():
        page.goto('http://127.0.0.1:3311')
        page.get_by_role('button', name='Verify wallet and start designing').click()
        select = page.get_by_label('Select strategy draft')
        expect(select).to_be_visible()
        select.select_option(label='My Maker strategy')
        expect(page.get_by_role('button', name='Inventory, compilation and simulation')).to_be_enabled()
    connect_maker()
    maker_conversation = page.get_by_label('Select strategy draft').input_value()
    page.get_by_role('button', name='Inventory, compilation and simulation').click()
    dialog = page.get_by_role('dialog', name='Maker inventory and swap simulation')
    expect(dialog.get_by_role('button', name='Read current inventory')).to_be_enabled()
    dialog.get_by_role('button', name='Read current inventory').click()
    expect(dialog.get_by_text('Test data · No onchain verification', exact=True)).to_be_visible()
    expect(dialog.get_by_text('Native ETH: 1 (for gas; excluded from WETH allocations)')).to_be_visible()
    expect(dialog.get_by_text('Insufficient allowance', exact=True)).to_have_count(2)
    expect(dialog.get_by_role('button', name='Simulate current compilation')).to_be_disabled()
    def lost_commit(route):
        response = route.fetch()
        assert response.status in [200, 202]
        route.abort('connectionfailed')
    page.route('**/compile', lost_commit, times=1)
    dialog.get_by_role('button', name='Compile current draft').click()
    expect(dialog.get_by_role('alert')).to_be_visible()
    dialog.get_by_role('button', name='Retry compilation confirmation').click()
    expect(dialog.get_by_text('Current v2 compilation saved')).to_be_visible()
    commits = [r for r in sent if r['url'].endswith('/compile')]
    assert len(commits) == 2 and commits[0]['key'] == commits[1]['key'] and commits[0]['body'] == commits[1]['body']
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=true')
    page.route('**/artifacts/*/simulations', lost_commit, times=1)
    dialog.get_by_role('button', name='Simulate current compilation').click()
    expect(dialog.get_by_role('alert')).to_be_visible()
    dialog.get_by_role('button', name='Retry simulation confirmation').click()
    expect(dialog.get_by_role('button', name='Cancel v2 simulation')).to_be_visible()
    requests = [r for r in sent if '/artifacts/' in r['url'] and r['url'].endswith('/simulations')]
    assert len(requests) == 2 and requests[0]['key'] == requests[1]['key'] and requests[0]['body'] == requests[1]['body']
    dialog.get_by_role('button', name='Cancel v2 simulation').click()
    expect(dialog.get_by_role('heading', name='v2 · Cancelled', exact=True)).to_be_visible()
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=false&skip=true')
    dialog.get_by_role('button', name='Simulate current compilation').click()
    expect(dialog.get_by_text('Some cases did not run. This is not a complete pass.')).to_be_visible(timeout=20000)
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=true')
    # Wait for durable acceptance, not job completion. Reloading an unaccepted
    # HTTP request can correctly abort it before any job exists.
    with page.expect_response(lambda r: '/artifacts/' in r.url and r.url.endswith('/simulations') and r.request.method == 'POST') as accepted:
        dialog.get_by_role('button', name='Simulate current compilation').click()
    assert accepted.value.status == 202
    assert accepted.value.json()['id']
    # The owned worker continues while the browser reloads and obtains a new wallet session.
    page.reload()
    page.get_by_role('button', name='Verify wallet and start designing').click()
    page.get_by_label('Select strategy draft').select_option(maker_conversation)
    page.get_by_role('button', name='Inventory, compilation and simulation').click()
    expect(dialog.get_by_text('All cases in this result passed. Requirements, policy and wallet checks remain.')).to_be_visible(timeout=20000)
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=false')
    cards = dialog.locator('article')
    expect(cards).to_have_count(3)
    cards.first.get_by_role('button', name='View v2 cases').click()
    expect(dialog.get_by_role('heading', name='Case details · v2')).to_be_visible()
    expect(dialog.get_by_text('Passed fixture-transfer', exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    dialog.get_by_role('button', name='Read current inventory').click()
    expect(dialog.get_by_text('Insufficient allowance', exact=True)).to_have_count(2)
    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth'), 'Preparation horizontal overflow'
    page.screenshot(path=str(artifacts / 'maker-preparation-mobile.png'), full_page=True)
    dialog.get_by_role('button', name='Close dialog').click()
    page.set_viewport_size({'width': 1440, 'height': 1100})
    composer = page.get_by_label('Describe your goals or what you want to change')
    composer.fill('Compare tiny allocations and preserve other limits.')
    page.get_by_role('button', name='Send ↗').click()
    expect(page.get_by_role('button', name='Stop generating')).to_have_count(0, timeout=20000)
    expect(page.get_by_text('Saved · v3', exact=True)).to_be_visible()
    page.get_by_role('button', name='Inventory, compilation and simulation').click()
    expect(dialog.get_by_role('button', name='Simulate current compilation')).to_be_disabled()
    expect(dialog.get_by_role('heading', name='v2 · Completed · Earlier revision', exact=True)).to_have_count(2)
    dialog.get_by_role('button', name='Compile current draft').click()
    expect(dialog.get_by_text('Current v3 compilation saved')).to_be_visible()
    dialog.get_by_role('button', name='Simulate current compilation').click()
    expect(dialog.get_by_role('heading', name='v3 · Failed', exact=True)).to_be_visible(timeout=20000)
    expect(dialog.get_by_text('Some cases failed. Refine the parameters in chat and retry.')).to_be_visible()
    dialog.get_by_role('heading', name='v3 · Failed', exact=True).scroll_into_view_if_needed()
    page.screenshot(path=str(artifacts / 'maker-preparation-failure-desktop.png'), full_page=True)
    dialog.get_by_role('button', name='Close dialog').click()
    # Restoring a previous revision creates v4; its old successful simulation remains stale.
    page.get_by_role('button', name='Versions and changes').click()
    page.get_by_role('button', name='Restore this revision').first.click()
    expect(page.get_by_text('Saved · v4', exact=True)).to_be_visible()
    page.get_by_role('button', name='Inventory, compilation and simulation').click()
    expect(dialog.get_by_role('button', name='Simulate current compilation')).to_be_disabled()
    expect(dialog.get_by_role('heading', name='v3 · Failed · Earlier revision', exact=True)).to_be_visible()
    # An expired session clears the preparation dialog; no asset signing API was ever available.
    page.route('**/inventory?revision=4', lambda r: r.fulfill(status=401, content_type='application/json', body='{"error":"authentication-required"}'), times=1)
    dialog.get_by_role('button', name='Read current inventory').click()
    expect(dialog).to_have_count(0)
    signed = page.evaluate('window.__fixtureSignedMessages')
    assert all('wants you to sign in' in m for m in signed), 'Preparation unexpectedly requested a wallet signature'
    assert not errors, errors
    browser.close()
print('PASS: Maker inventory/evidence labels, real compilation, idempotent lost-response recovery, mock background simulation/cancel/reload, incomplete coverage, failure, stale edit/restore, session expiry and mobile; no asset signatures/page errors')
