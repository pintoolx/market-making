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
        page.get_by_role('button', name='驗證錢包並開始設計').click()
        select = page.get_by_label('選擇策略草稿')
        expect(select).to_be_visible()
        select.select_option(label='我的 Maker 策略')
        expect(page.get_by_role('button', name='資產、編譯與成交模擬')).to_be_enabled()
    connect_maker()
    maker_conversation = page.get_by_label('選擇策略草稿').input_value()
    page.get_by_role('button', name='資產、編譯與成交模擬').click()
    dialog = page.get_by_role('dialog', name='Maker 資產與成交模擬')
    expect(dialog.get_by_role('button', name='讀取目前資產')).to_be_enabled()
    dialog.get_by_role('button', name='讀取目前資產').click()
    expect(dialog.get_by_text('測試資料 · 非鏈上驗證', exact=True)).to_be_visible()
    expect(dialog.get_by_text('原生 ETH：1（gas 使用，不計入 WETH 配置）')).to_be_visible()
    expect(dialog.get_by_text('allowance 不足', exact=True)).to_have_count(2)
    expect(dialog.get_by_role('button', name='模擬目前編譯')).to_be_disabled()
    def lost_commit(route):
        response = route.fetch()
        assert response.status in [200, 202]
        route.abort('connectionfailed')
    page.route('**/compile', lost_commit, times=1)
    dialog.get_by_role('button', name='編譯目前草稿').click()
    expect(dialog.get_by_role('alert')).to_be_visible()
    dialog.get_by_role('button', name='重試確認編譯').click()
    expect(dialog.get_by_text('目前 v2 編譯已保存')).to_be_visible()
    commits = [r for r in sent if r['url'].endswith('/compile')]
    assert len(commits) == 2 and commits[0]['key'] == commits[1]['key'] and commits[0]['body'] == commits[1]['body']
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=true')
    page.route('**/artifacts/*/simulations', lost_commit, times=1)
    dialog.get_by_role('button', name='模擬目前編譯').click()
    expect(dialog.get_by_role('alert')).to_be_visible()
    dialog.get_by_role('button', name='重試確認模擬').click()
    expect(dialog.get_by_role('button', name='取消 v2 模擬')).to_be_visible()
    requests = [r for r in sent if '/artifacts/' in r['url'] and r['url'].endswith('/simulations')]
    assert len(requests) == 2 and requests[0]['key'] == requests[1]['key'] and requests[0]['body'] == requests[1]['body']
    dialog.get_by_role('button', name='取消 v2 模擬').click()
    expect(dialog.get_by_role('heading', name='v2 · 已取消', exact=True)).to_be_visible()
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=false&skip=true')
    dialog.get_by_role('button', name='模擬目前編譯').click()
    expect(dialog.get_by_text('仍有未執行案例，不能當作完整通過。')).to_be_visible(timeout=20000)
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=true')
    # Wait for durable acceptance, not job completion. Reloading an unaccepted
    # HTTP request can correctly abort it before any job exists.
    with page.expect_response(lambda r: '/artifacts/' in r.url and r.url.endswith('/simulations') and r.request.method == 'POST') as accepted:
        dialog.get_by_role('button', name='模擬目前編譯').click()
    assert accepted.value.status == 202
    assert accepted.value.json()['id']
    # The owned worker continues while the browser reloads and obtains a new wallet session.
    page.reload()
    page.get_by_role('button', name='驗證錢包並開始設計').click()
    page.get_by_label('選擇策略草稿').select_option(maker_conversation)
    page.get_by_role('button', name='資產、編譯與成交模擬').click()
    expect(dialog.get_by_text('此結果的案例皆通過；仍需需求、政策與錢包檢查。')).to_be_visible(timeout=20000)
    page.request.get('http://127.0.0.1:3311/fixture/simulation-control?slow=false')
    cards = dialog.locator('article')
    expect(cards).to_have_count(3)
    cards.first.get_by_role('button', name='查看 v2 案例').click()
    expect(dialog.get_by_role('heading', name='案例詳情 · v2')).to_be_visible()
    expect(dialog.get_by_text('通過 fixture-transfer', exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    dialog.get_by_role('button', name='讀取目前資產').click()
    expect(dialog.get_by_text('allowance 不足', exact=True)).to_have_count(2)
    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth'), 'Preparation horizontal overflow'
    page.screenshot(path=str(artifacts / 'maker-preparation-mobile.png'), full_page=True)
    dialog.get_by_role('button', name='關閉視窗').click()
    page.set_viewport_size({'width': 1440, 'height': 1100})
    composer = page.get_by_label('描述目標或這次想調整的地方')
    composer.fill('改成極小配置來比較，保留其他限制。')
    page.get_by_role('button', name='送出 ↗').click()
    expect(page.get_by_role('button', name='停止生成')).to_have_count(0, timeout=20000)
    expect(page.get_by_text('已保存 · v3', exact=True)).to_be_visible()
    page.get_by_role('button', name='資產、編譯與成交模擬').click()
    expect(dialog.get_by_role('button', name='模擬目前編譯')).to_be_disabled()
    expect(dialog.get_by_role('heading', name='v2 · 已完成 · 舊版', exact=True)).to_have_count(2)
    dialog.get_by_role('button', name='編譯目前草稿').click()
    expect(dialog.get_by_text('目前 v3 編譯已保存')).to_be_visible()
    dialog.get_by_role('button', name='模擬目前編譯').click()
    expect(dialog.get_by_role('heading', name='v3 · 未通過', exact=True)).to_be_visible(timeout=20000)
    expect(dialog.get_by_text('有案例未通過，可回到對話調整參數後重試。')).to_be_visible()
    dialog.get_by_role('heading', name='v3 · 未通過', exact=True).scroll_into_view_if_needed()
    page.screenshot(path=str(artifacts / 'maker-preparation-failure-desktop.png'), full_page=True)
    dialog.get_by_role('button', name='關閉視窗').click()
    # Restoring a previous revision creates v4; its old successful simulation remains stale.
    page.get_by_role('button', name='版本與變更').click()
    page.get_by_role('button', name='恢復此版本').first.click()
    expect(page.get_by_text('已保存 · v4', exact=True)).to_be_visible()
    page.get_by_role('button', name='資產、編譯與成交模擬').click()
    expect(dialog.get_by_role('button', name='模擬目前編譯')).to_be_disabled()
    expect(dialog.get_by_role('heading', name='v3 · 未通過 · 舊版', exact=True)).to_be_visible()
    # An expired session clears the preparation dialog; no asset signing API was ever available.
    page.route('**/inventory?revision=4', lambda r: r.fulfill(status=401, content_type='application/json', body='{"error":"authentication-required"}'), times=1)
    dialog.get_by_role('button', name='讀取目前資產').click()
    expect(dialog).to_have_count(0)
    signed = page.evaluate('window.__fixtureSignedMessages')
    assert all('wants you to sign in' in m for m in signed), 'Preparation unexpectedly requested a wallet signature'
    assert not errors, errors
    browser.close()
print('PASS: Maker inventory/evidence labels, real compilation, idempotent lost-response recovery, mock background simulation/cancel/reload, incomplete coverage, failure, stale edit/restore, session expiry and mobile; no asset signatures/page errors')
