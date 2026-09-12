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
    expect(page.get_by_role('heading', name='把你的想法，變成策略。')).to_be_visible()
    page.get_by_role('button', name='驗證錢包並開始設計').click()
    composer = page.get_by_label('描述目標或這次想調整的地方')
    expect(composer).to_be_enabled()
    summary = page.get_by_role('complementary', name='目前策略')

    def send(text):
        composer.fill(text)
        page.get_by_role('button', name='送出 ↗').click()

    def finished(revision):
        expect(page.get_by_text(f'已保存 · v{revision}', exact=True)).to_be_visible(timeout=20000)
        expect(page.get_by_role('button', name='停止生成')).to_have_count(0, timeout=20000)
        expect(page.get_by_role('alert')).to_have_count(0)

    def caps_unchanged():
        expect(summary.get_by_role('row', name='WETH 0.05 2', exact=True)).to_be_visible()
        expect(summary.get_by_role('row', name='USDC 125 5000', exact=True)).to_be_visible()

    send('建立 WETH / USDC 固定區間 2200 到 2800，零費率，單筆 0.05 WETH / 125 USDC，庫存 2 WETH / 5000 USDC。')
    expect(page.get_by_role('button', name='停止生成')).to_be_visible()
    expect(page.locator('article[aria-busy="true"]')).to_be_visible(timeout=15000)
    finished(2)
    expect(summary.get_by_text('公開設定完整', exact=True)).to_be_visible()
    caps_unchanged()
    page.screenshot(path=str(artifacts / 'browser-desktop.png'), full_page=True)

    send('只把價格上限改成 2700，其他限制保留。')
    finished(3)
    expect(summary.get_by_text('2700', exact=True)).to_be_visible()
    caps_unchanged()

    page.get_by_role('button', name=re.compile('版本與變更')).click()
    # The nearest version row owns exactly one restore button.
    summary.get_by_text('v2', exact=True).locator('..').get_by_role('button', name='恢復此版本').click()
    finished(4)
    expect(summary.get_by_text('2800', exact=True)).to_be_visible()
    caps_unchanged()
    page.get_by_role('button', name=re.compile('版本與變更')).click()

    send('請慢慢比較風險，這次不要改設定。')
    expect(page.locator('article[aria-busy="true"]')).to_be_visible(timeout=15000)
    page.get_by_role('button', name='停止生成').click()
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
    lost = '慢慢說明現有策略，不要變更；測試重新連線。'
    send(lost)
    expect(page.get_by_role('alert')).to_be_visible(timeout=10000)
    page.get_by_role('button', name='重新載入').click()
    expect(page.get_by_role('alert')).to_have_count(0)
    expect(page.get_by_role('button', name='停止生成')).to_be_visible()
    page.get_by_role('button', name='停止生成').click()
    finished(4)
    expect(page.locator('article').get_by_text(lost, exact=True)).to_have_count(1)
    expect(composer).to_have_value('')

    page.reload()
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='驗證錢包並開始設計').click()
    finished(4)
    caps_unchanged()
    expect(page.locator('article').get_by_text(lost, exact=True)).to_have_count(1)

    # Session expiry returns to wallet proof without stranding the user in a reload loop.
    page.route('**/turns/*/events?*', lambda route: route.fulfill(status=401, json={'error': 'authentication-required'}), times=1)
    send('慢慢分析，不要修改設定。登入過期測試。')
    expect(page.get_by_role('button', name='驗證錢包並開始設計')).to_be_visible()
    page.get_by_role('button', name='驗證錢包並開始設計').click()
    expect(page.get_by_role('button', name='停止生成')).to_be_visible()
    page.get_by_role('button', name='停止生成').click()
    finished(4)

    page.set_viewport_size({'width': 390, 'height': 844})
    expect(composer).to_be_enabled()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow on mobile'
    composer.scroll_into_view_if_needed()
    page.screenshot(path=str(artifacts / 'browser-mobile.png'), full_page=True)
    bottom = page.get_by_role('button', name=re.compile('版本與變更'))
    bottom.scroll_into_view_if_needed()
    expect(bottom).to_be_in_viewport()
    page.screenshot(path=str(artifacts / 'browser-mobile-summary.png'), full_page=True)
    heading = page.get_by_role('heading', name='把你的想法，變成策略。')
    heading.scroll_into_view_if_needed()
    expect(heading).to_be_in_viewport()
    assert not errors, errors
    print('PASS: wallet proof, streaming, CLMM edits/caps, restore, cancel, lost-response recovery, reload, session expiry, mobile; no page errors')
    browser.close()
