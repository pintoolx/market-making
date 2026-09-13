"""Local actual UI/API/PostgreSQL/encryption acceptance; fixture Privy/wallet/model only."""
import re
from uuid import uuid4
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

artifacts = Path('.cache/builder')
artifacts.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    public_title = 'template-acceptance-' + uuid4().hex[:8]
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors, sent = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: sent.append({'url': req.url, 'body': req.post_data or '', 'key': req.headers.get('idempotency-key')}) if '/v1/builder/' in req.url else None)
    page.goto('http://127.0.0.1:3311')
    page.get_by_role('button', name='Verify wallet and start designing').click()
    composer = page.get_by_label('Describe your goals or what you want to change')
    expect(composer).to_be_enabled()
    page.get_by_role('button', name='+ New draft').click()
    expect(page.get_by_text('Saved · v1', exact=True)).to_be_visible()
    composer.fill('Create a complete zero-fee WETH / USDC CLMM with public trade and inventory limits, titled ' + public_title + '。')
    page.get_by_role('button', name='Send ↗').click()
    expect(page.get_by_role('button', name='Stop generating')).to_have_count(0, timeout=20000)
    expect(page.get_by_text('Saved · v2', exact=True)).to_be_visible()
    provider_conversation = page.get_by_label('Select strategy draft').input_value()
    page.get_by_role('button', name='Add private rules and publish').click()
    dialog = page.get_by_role('dialog', name='Publish a strategy version')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('region', name='Private policy editor')).to_be_visible()
    # Rule 1 pauses when volatility is high; rule 2 buys in a private range; fallback sells.
    dialog.get_by_label('Rule 1 Minimum volatility').fill('200')
    dialog.get_by_role('button', name='+ Add rule').click()
    dialog.get_by_label('Rule 2 Minimum price').fill('2345.12345678')
    dialog.get_by_label('Rule 2 Maximum price').fill('2678.12345678')
    dialog.get_by_label('Rule 2 Maximum volatility').fill('199')
    dialog.get_by_label('Rule 2 Allow the liquidity wallet to buy WETH').check()
    dialog.get_by_label('Rule 2 WETH per-swap limit').fill('0.01')
    dialog.get_by_label('Rule 2 USDC per-swap limit').fill('100')
    dialog.get_by_role('button', name='+ Add rule').click()
    dialog.get_by_label('Rule 3 Allow the liquidity wallet to sell WETH').check()
    dialog.get_by_label('Rule 3 WETH per-swap limit').fill('0.02')
    dialog.get_by_label('Rule 3 USDC per-swap limit').fill('50')
    # Reordering an unconditional fallback above later rules is rejected locally, before prepare HTTP.
    dialog.get_by_role('button', name='Rule 3 Move up').click()
    dialog.get_by_role('button', name='Rule 2 Move up').click()
    dialog.get_by_label('I have reviewed the public parameters, editable bounds and private rules above').check()
    before = len([r for r in sent if r['url'].endswith('/templates/prepare')])
    dialog.get_by_role('button', name='Encrypt and review version').click()
    expect(dialog.get_by_role('alert')).to_contain_text('An unconditional rule hides later rules')
    assert len([r for r in sent if r['url'].endswith('/templates/prepare')]) == before
    dialog.get_by_role('button', name='Rule 1 Move down').click()
    dialog.get_by_role('button', name='Rule 2 Move down').click()
    dialog.get_by_label('I have reviewed the public parameters, editable bounds and private rules above').check()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth'), 'Private editor horizontal overflow'
    page.screenshot(path=str(artifacts / 'template-private-editor-mobile.png'), full_page=True)
    dialog.get_by_role('button', name='Encrypt and review version').click()
    expect(dialog.get_by_role('button', name='Sign and publish')).to_be_enabled()
    expect(dialog.get_by_label('Rule 2 Minimum price')).to_be_disabled()
    assert all('2345.12345678' not in r['body'] and '2678.12345678' not in r['body'] for r in sent)

    def lost_commit(route):
        response = route.fetch()
        assert response.status == 200
        route.abort('connectionfailed')
    page.route('**/templates/publish', lost_commit, times=1)
    dialog.get_by_role('button', name='Sign and publish').click()
    expect(dialog.get_by_role('alert')).to_be_visible()
    dialog.get_by_role('button', name='Retry publication confirmation').click()
    expect(dialog.get_by_text('Makers can now select this version. Your confidential form has been cleared from this browser.')).to_be_visible()
    expect(dialog.get_by_role('region', name='Private policy editor')).to_have_count(0)
    signed = page.evaluate('window.__fixtureSignedMessages')
    assert len([m for m in signed if m.startswith('Publish Pintool Provider template')]) == 1
    requests = [r for r in sent if r['url'].endswith('/templates/publish')]
    assert len(requests) == 2 and requests[0]['body'] == requests[1]['body'] and requests[0]['key'] == requests[1]['key']
    check = page.request.get('http://127.0.0.1:3311/fixture/policy-check')
    assert check.status == 200 and check.json() == {'verified': True, 'scope': 'local-fixture-decryption-and-existing-evaluator', 'teeVerified': False}
    page.screenshot(path=str(artifacts / 'template-published-mobile.png'), full_page=True)
    dialog.get_by_role('button', name='Back to strategy').click()
    page.get_by_role('button', name='Add private rules and publish').click()
    expect(dialog.get_by_label('Rule 1 Minimum price')).to_have_value('')
    expect(dialog.get_by_label('Rule 2 Minimum price')).to_have_count(0)
    dialog.get_by_role('button', name='Close dialog').click()
    page.set_viewport_size({'width': 1440, 'height': 1100})
    page.get_by_role('button', name='Browse templates').click()
    catalog = page.get_by_role('dialog', name='Choose a published strategy')
    catalog.get_by_role('button', name=re.compile(re.escape(public_title) + '.*Version 1')).click()
    expect(catalog.get_by_text('Provider signature verified. Your liquidity remains pinned to this version if the provider publishes an update.')).to_be_visible()
    catalog.get_by_label('WETH Maker allocation').fill('0.01')
    catalog.get_by_label('USDC Maker allocation').fill('25')
    catalog.get_by_label('Personal strategy title').fill('My Maker strategy')
    page.screenshot(path=str(artifacts / 'template-maker-review-desktop.png'), full_page=True)
    page.route('**/templates/instantiate', lost_commit, times=1)
    catalog.get_by_role('button', name='Use this version').click()
    expect(catalog.get_by_role('alert')).to_be_visible()
    expect(catalog.get_by_label('USDC Maker allocation')).to_be_disabled()
    catalog.get_by_role('button', name='Retry creating this draft').click()
    expect(catalog).to_have_count(0)
    expect(page.get_by_text('Liquidity draft · Not active')).to_be_visible()
    expect(page.get_by_text('0.01 WETH + 25 USDC', exact=True)).to_be_visible()
    requests = [r for r in sent if r['url'].endswith('/templates/instantiate')]
    assert len(requests) == 2 and requests[0]['key'] == requests[1]['key'] and requests[0]['body'] == requests[1]['body']
    composer.fill('Change only the maximum price to 2700 and preserve other limits.')
    page.get_by_role('button', name='Send ↗').click()
    expect(page.get_by_role('button', name='Stop generating')).to_have_count(0, timeout=20000)
    expect(page.get_by_text('Saved · v2', exact=True)).to_be_visible()
    expect(page.get_by_role('alert')).to_have_count(0)
    summary = page.get_by_role('complementary', name='Current strategy')
    expect(summary.get_by_text('2700', exact=True)).to_be_visible()
    page.get_by_role('button', name='Browse templates').click()
    catalog.get_by_role('button', name=re.compile(re.escape(public_title) + '.*Version 1')).click()
    catalog.get_by_label('I understand that withdrawing this version does not revoke existing trading authorizations').check()
    catalog.get_by_role('button', name='Sign and withdraw version').click()
    expect(catalog.get_by_text(re.compile('The provider withdrew this version'))).to_be_visible()
    expect(catalog.get_by_role('button', name='Use this version')).to_have_count(0)
    catalog.get_by_role('button', name='Close dialog').click()
    page.get_by_label('Select strategy draft').select_option(provider_conversation)
    expect(page.get_by_role('button', name='Add private rules and publish')).to_be_enabled()
    # An expired prepare response must release its idempotency key so a fresh review can proceed.
    page.get_by_role('button', name='Add private rules and publish').click()
    def expired_intent(route):
        response = route.fetch()
        assert response.status == 200
        body = response.json()
        body['intent']['expiresAt'] = '2000-01-01T00:00:00.000Z'
        route.fulfill(response=response, json=body)
    page.route('**/templates/prepare', expired_intent, times=1)
    dialog.get_by_label('I have reviewed the public parameters, editable bounds and private rules above').check()
    dialog.get_by_role('button', name='Encrypt and review version').click()
    expect(dialog.get_by_role('alert')).to_contain_text('The publication review expired')
    dialog.get_by_label('I have reviewed the public parameters, editable bounds and private rules above').check()
    dialog.get_by_role('button', name='Encrypt and review version').click()
    expect(dialog.get_by_role('button', name='Sign and publish')).to_be_enabled()
    prepare_requests = [r for r in sent if r['url'].endswith('/templates/prepare')]
    assert prepare_requests[-1]['key'] != prepare_requests[-2]['key']
    dialog.get_by_role('button', name='Close dialog').click()
    # Expiry during private editing returns to wallet proof and destroys the editor state.
    page.get_by_role('button', name='Add private rules and publish').click()
    dialog.get_by_label('Rule 1 Minimum price').fill('2555.87654321')
    page.route('**/templates/prepare', lambda route: route.fulfill(status=401, json={'error': 'authentication-required'}), times=1)
    dialog.get_by_label('I have reviewed the public parameters, editable bounds and private rules above').check()
    dialog.get_by_role('button', name='Encrypt and review version').click()
    expect(dialog).to_have_count(0)
    page.get_by_role('button', name='Verify wallet and start designing').click()
    expect(page.get_by_label('Select strategy draft')).to_be_enabled()
    page.get_by_label('Select strategy draft').select_option(provider_conversation)
    page.get_by_role('button', name='Add private rules and publish').click()
    expect(dialog.get_by_label('Rule 1 Minimum price')).to_have_value('')
    dialog.get_by_role('button', name='Close dialog').click()
    assert all('2345.12345678' not in r['body'] and '2678.12345678' not in r['body'] for r in sent)
    assert all('2555.87654321' not in r['body'] for r in sent)
    stored = page.evaluate('JSON.stringify({local: {...localStorage}, session: {...sessionStorage}})')
    assert '2345.12345678' not in stored and '2678.12345678' not in stored
    assert not errors, errors
    print('PASS: ordered private rules, local validation, encryption/evaluator compatibility, no plaintext API/storage, signed publication and retry, clear-on-close, Maker instance and retry, pinned conversation, signed withdrawal, intent/session expiry, mobile; no page errors')
    browser.close()
