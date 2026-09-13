# Builder 需求確認

策略對話中的自然語言需求先由 agent 轉成公開、可審閱的 criteria。criteria 只描述公開策略值或已核對的機制，不包含私密政策、密文、錢包簽名或「已授權」宣稱。

每一條 requirement 都要由使用者選擇一個決定：

- `confirm`：接受這個具體解讀。參數必須與目前草稿相符；機制描述只代表同意預期範圍，不代表 report 已送出。
- `accept-limitation`：明確接受服務目前無法實現或目前值未符合的限制。它會留下可追蹤的草稿標記，不能被 agent 自動設定。

服務會將 review intent 和 receipt 寫入不可變的 PostgreSQL 表，並綁定 owner、draft、revision、公開內容 digest、部署 manifest 及 review engine 版本。修改或恢復草稿後，舊 receipt 不再是目前版本的確認；若 waiver 使草稿產生新 revision，也必須重新經過後續編譯與錢包 gates。

HTTP 介面掛在 `/v1/builder`：

```text
POST /drafts/:draftId/requirement-review
GET  /drafts/:draftId/requirement-review?revision=N
POST /requirement-reviews/:reviewId/confirm
```

prepare 回傳公開 review 與 digest；confirm 的 body 只有 `digest` 和每條 requirement 的 decision。所有請求仍需要現有錢包 session、owner scope 與 idempotency key。Provider 模板發布若有 requirements，必須先有目前 revision 的 receipt；Maker 編譯／模擬／未來錢包註冊仍是獨立 gates。

四種證據層級會分開顯示：`onchain_enforced`、`preflight_only`、`informational`、`unsupported`。Guard 的方向與單筆／庫存上限是程式與 report 的交集；策略曲線和 allocation 的比較不等於即時行情、獨立保留資金或每日額度。條件相符也不等於 CRE delivery、standing report、Aqua ship 或成交已完成。
