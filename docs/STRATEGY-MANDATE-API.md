# Frontend strategy mandate API

狀態：2026-09-12 integration contract。這是 PinTool 團隊需要提供的 orchestration／status service，不是 Chainlink 或 1inch 的官方 endpoint。Base URL 由 `NEXT_PUBLIC_MANDATE_API_URL` 提供。

前端只建立 mandate、讀取已確認狀態與 activity。市場 fixture、CRE delivery 與 test-taker swap 由 workflow／contract tooling 驅動，不暴露成產品操作。Service 不得回傳「預期會成功」的結果冒充已確認 evidence。

原始 Provider policy 與 Maker mandate 必須走經驗證的 confidential input path；若 transport 尚未完成，service 必須拒絕請求，不能把 plaintext 留在一般 backend logs。

## Create a mandate

`POST /v1/mandates`

```json
{
  "maker": "0x...",
  "providerStrategyIds": [
    "featured-tight-market",
    "featured-defensive-market"
  ],
  "policy": {
    "capitalBudgetUsdc": "1000",
    "maxWethExposurePct": "60",
    "maxWethInventoryUsdc": "350",
    "maxSwapUsdc": "100",
    "validityMinutes": "10"
  }
}
```

`providerStrategyIds` 至少一筆，產品不限制恰好兩筆。首次 onboarding 只送使用者在 detail page 選定的策略；後續 portfolio expansion 才加入更多策略。ETHOnline 錄影 fixture 固定使用上面兩套策略。

Response 必須代表 initial report 已由 Guard 接受：

```json
{
  "mandateId": "mandate-01",
  "regime": "normal",
  "strategies": [
    {
      "listingId": "featured-tight-market",
      "name": "Tight Market",
      "provider": "PinTool Strategies",
      "strategyHash": "0x...",
      "status": "active",
      "maxAmountPerSwapAtomic": "100000000"
    },
    {
      "listingId": "featured-defensive-market",
      "name": "Defensive Market",
      "provider": "PinTool Strategies",
      "strategyHash": "0x...",
      "status": "standby",
      "maxAmountPerSwapAtomic": "100000000"
    }
  ],
  "evidence": {
    "chainId": 11155111,
    "networkName": "Ethereum Sepolia",
    "reportDigest": "0x...",
    "reportTransactionHash": "0x...",
    "reportExplorerUrl": "https://sepolia.etherscan.io/tx/0x...",
    "sequence": "1",
    "expiresAt": "2026-09-12T00:00:00Z"
  },
  "events": []
}
```

## Read current state

`GET /v1/mandates/:mandateId`

回傳同一個 `MandateState`。當 CRE report、Guard state 或 Aqua receipt 更新後，service 重新讀取可驗證來源並更新：

- `regime`: `normal | high-volatility | unknown`
- 每套 strategy 的 `status`: `active | standby | paused`
- `evidence.sequence`、expiry、digest 與 report transaction
- `events`: `report-accepted | strategy-activated | swap-settled | swap-rejected`

每個 event 包含 `id`、`type`、`title`、`detail`、`occurredAt`，有鏈上交易時再附 `transactionHash` 與 `explorerUrl`。

## Required invariants

- Strategy set 至少一套，任一狀態最多一套 `active`。
- chainId、network、token pair、strategy hash 與 Explorer URL 必須來自同一個 deployment。
- sequence 必須單調遞增；expiresAt 必須對應 Guard 接受的 report。
- transactionHash 必須能由獨立 RPC 查到 receipt。
- `swap-settled` 只能來自成功 receipt；`swap-rejected` 必須來自實際 revert／失敗 receipt，不能由 UI 推測。
- Service 不得把 private policy、Provider thresholds、模型 chain of thought 或秘密來源回傳前端。
