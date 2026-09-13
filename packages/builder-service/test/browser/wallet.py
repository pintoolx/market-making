"""Actual browser/API/PG/receipt recovery on an owned Sepolia fork; synthetic wallet/report authority."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def open_wallet():
        page.goto('http://127.0.0.1:3311')
        page.get_by_role('button', name='Verify wallet and start designing').click()
        page.get_by_label('Select strategy draft').select_option(label='Wallet fork acceptance')
        page.get_by_role('button', name='Check liquidity and test execution').click()
    open_wallet()
    dialog = page.get_by_role('dialog', name='Review liquidity and test execution')
    wallet = dialog.get_by_role('region', name='Wallet transaction execution')
    expect(dialog.get_by_text('All cases in this result passed. Requirements, policy and wallet checks remain.')).to_be_visible()
    dialog.get_by_role('button', name='Prepare approve and ship plan').click()
    def plan(kind):
        return wallet.get_by_role('article').filter(has=page.get_by_text(kind + ' · v2', exact=True))
    def send(kind, index=0):
        card = plan(kind)
        card.get_by_role('button', name='Review and sign transaction', exact=True).nth(index).click()
    page.evaluate('window.__fixtureRejectWallet = true')
    send('registration')
    expect(plan('registration').get_by_text('Wallet request cancelled', exact=True)).to_be_visible(timeout=20000)
    page.evaluate('window.__fixtureLoseHash = true')
    send('registration')
    expect(wallet.get_by_role('alert')).to_contain_text('response lost after send', timeout=20000)
    # No transaction hash reached either localStorage or the backend. Recover
    # after a fresh wallet session solely from the persisted Maker + nonce.
    open_wallet()
    wallet.get_by_role('button', name='Check transaction', exact=True).click()
    expect(plan('registration').get_by_text('Confirmed onchain', exact=False)).to_have_count(1, timeout=30000)
    send('registration', 1)
    expect(plan('registration').get_by_text('Confirmed onchain', exact=False)).to_have_count(2, timeout=30000)
    send('registration', 2)
    expect(plan('registration').get_by_text('Confirmed onchain', exact=False)).to_have_count(3, timeout=30000)
    def action(name):
        response = page.request.get('http://127.0.0.1:3311/fixture/wallet-action/' + name, timeout=30000)
        assert response.ok, name + ': ' + response.text()
        assert response.json()['ok']
    action('allow'); action('trade'); action('pause'); action('blocked')
    dialog.get_by_role('button', name='Prepare direct Guard revocation').click()
    send('guard-revoke')
    expect(plan('guard-revoke').get_by_text('Confirmed onchain', exact=False)).to_have_count(1, timeout=30000)
    action('blocked')
    dialog.get_by_role('button', name='Prepare clearing Guard revocation').click()
    send('guard-unrevoke')
    expect(plan('guard-unrevoke').get_by_text('Confirmed onchain', exact=False)).to_have_count(1, timeout=30000)
    action('allow'); action('trade')
    dialog.get_by_role('button', name='Prepare dock plan').click()
    send('cancellation')
    expect(plan('cancellation').get_by_text('Confirmed onchain', exact=False)).to_have_count(1, timeout=30000)
    dialog.get_by_role('button', name='Prepare shared allowance revocation').click()
    send('allowance-revoke')
    expect(plan('allowance-revoke').get_by_text('Confirmed onchain', exact=False)).to_have_count(1, timeout=30000)
    send('allowance-revoke', 1)
    expect(plan('allowance-revoke').get_by_text('Confirmed onchain', exact=False)).to_have_count(2, timeout=30000)
    action('evidence')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth'), 'Wallet view horizontal overflow'
    page.screenshot(path=str(Path('.cache/builder/wallet-fork-mobile.png')), full_page=True)
    assert not errors, errors
    browser.close()
print('PASS: real browser wallet approve/ship/revoke/unrevoke/dock/allowance revocation; rejection, lost hash and reload recovery; fork trades and veto; no public-chain writes')
