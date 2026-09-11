# 使用情境與 UX 走查

日期：2026-09-12。原則：簡單易懂、敢信任。每一步只講一件事；牽涉到錢的地方講清楚錢在誰手上、別人看得到什麼、什麼時候要簽名；功能還沒開放就直接說。

網址：`/` 主頁、`/studio` Provider、`/maker` Maker、`/profile` 個人頁。

## 三種人

**訪客或評審**：第一次來，沒登入。要在十秒內知道 PinTool 在做什麼，選一個角色進去；不用登入就能逛完整條流程。

**Provider**：懂策略的人。選模板、寫公開介紹和私密邏輯、設定績效費、發布；之後回來編輯或下架。Maker 賺錢時分到一部分。

**Maker**：有資金的人。選策略、設定預算和曝險上限、看提案；資金一直在自己錢包，只有獲利時才付 Provider 的費用。

## 情境與對應的設計

| 情境 | 現在的做法 |
|---|---|
| 訪客想知道這是什麼 | 主頁一屏看完：標語講兩邊各賺什麼、兩張角色卡片、架構圖。窄螢幕改成標語在上、卡片在下 |
| 訪客想先逛再決定 | 所有頁面不用登入就能看、能走流程；只有發布策略需要登入 |
| Provider 寫到一半切去看市場 | 草稿存在這個分頁的瀏覽器裡，回來卡片顯示「Continue draft」 |
| Provider 不知道為什麼不能下一步 | 按鈕下方寫「Fill in every field to continue.」 |
| Provider 發布 | 沒登入時按鈕是「Log in to publish」，說明名字會放在策略上；發布後停在成功頁，可以去市場看、再建一個、或到 Profile 管理，不會被丟到 Maker 頁 |
| Provider 擔心私密邏輯外洩 | 私密區塊用虛線框，寫明 Maker 看不到、發布後不保存 |
| Provider 想改或下架 | Profile → Providing 每張卡片有 Edit 和 Unpublish；下架要按兩次確認 |
| Maker 選策略 | 卡片顯示作者（頭貼＋名字）和績效費「Fee: 12% of profit」 |
| Maker 不懂欄位意思 | 每欄下方有一句白話說明；輸入錯誤直接提示正確範圍，錯的時候不能送出 |
| Maker 用 email 登入 | 提醒 Privy 錢包一開始是空的，要先轉入資金，或改用自己的錢包登入 |
| Maker 擔心安全 | 「Before you commit」清單：資金留在自己錢包、雙方看不到彼此的秘密、不簽名不會動用、只有獲利才付費 |
| Maker 看完提案，但還不能執行 | 直接寫「Execution on Aqua is not open yet」，提案存到 Profile → Making，之後可以回來看或移除 |
| 使用者想看自己做過什麼 | Profile 最上面是精簡身分列，下面 Providing／Making／Account 三個分頁，策略優先 |
| 使用者想設定個人資料 | Account 分頁：頭貼、名字、自介、X 帳號；登入方式、email、錢包地址（點地址即可複製） |

## 用語

卡片上的機制改用白話：Constant product、Price range、Stable pair、Decay pricing、Inventory control、Shared capital。技術名稱（XYC、CLMM、PeggedSwap…）只在編輯頁說明留一行。篩選改為 Core／Add-ons／Capital。

## 驗證

用無頭 Chrome 自動跑完整的 Provider 與 Maker 情境（20 項檢查），桌機 1440 寬與手機 390 寬都通過；登入門檻另外在有 Privy 的設定下測試。登入後才出現的畫面（帳號選單、Account 分頁）用測試頁搭假資料驗證，沒有用真帳號登入。

## 還沒做的

- 所有資料（已發布策略、提案、個人資料）目前存在使用者自己的瀏覽器，換裝置就看不到；要等後端或 TEE 接上。
- 執行按鈕還沒接 Aqua 合約；Guard 與報告格式見 [AQUA-STRATEGY-DEEP-DIVE.md](AQUA-STRATEGY-DEEP-DIVE.md)。
- 績效費目前只是顯示與記錄，還沒有結算機制；「獲利」怎麼算要先定義（見下）。
- Email 登入的錢包餘額沒有實際查詢，只依登入方式提醒。

## 績效費要先想清楚的事

- 「獲利」以什麼為基準：以美元計的市值變化，還是跟單純持有相比。做市常見的是幣價下跌時手續費收入抵不過庫存縮水，這時不應收費。
- 要有最高水位（high-water mark）：虧損後回本的那一段不收費，只收創新高的部分。
- 結算時點與方式：定期結算，還是 Maker 下架時一次結算；費用從哪個代幣扣。
