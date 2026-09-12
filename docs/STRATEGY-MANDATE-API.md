# Frontend strategy mandate API

狀態：2026-09-12 integration contract。前端已依這份介面移除假的時間延遲與成功狀態；workflow／contracts owner 必須回傳已確認的 evidence，不能只回傳預期結果。

Base URL 由 NEXT_PUBLIC_MANDATE_API_URL 提供。所有 endpoint 使用 JSON。原始 Provider policy 與 Maker mandate 必須走經驗證的 confidential input path；若 transport 尚未完成，service 必須拒絕請求，不能把 plaintext 留在一般 backend logs。

## Evaluate

POST /v1/mandates/evaluate

Request：

```json
{
  "maker": "0x...",
  "providerStrategies": [
    { "slot": "A", "listingId": "featured-tight-market" },
    { "slot": "B", "listingId": "featured-defensive-market" }
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

Response 必須代表 report 已由 Guard 接受，不是尚未送出的 evaluator output：

```json
{
  "mandateId": "0x...",
  "regime": "normal",
  "activeSlot": "A",
  "decisions": [
    {
      "slot": "A",
      "listingId": "featured-tight-market",
      "strategyHash": "0x...",
      "allowed": true,
      "maxAmountPerSwapAtomic": "100000000"
    },
    {
      "slot": "B",
      "listingId": "featured-defensive-market",
      "strategyHash": "0x...",
      "allowed": false,
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
  }
}
```

## Change market regime

POST /v1/mandates/:mandateId/transition

這個 endpoint 只用於可重現的錄影 fixture。它再次執行相同 confidential workflow，並在 Guard 確認新 report 後回傳同一種 response。第二次結果必須是 sequence 遞增、activeSlot B；不得由前端直接指定 B。

正式產品應由可驗證 market trigger 觸發重新評估，不保留這個人工 transition endpoint。

## Execute or prove rejection

POST /v1/mandates/:mandateId/swaps

Request：

```json
{ "slot": "A" }
```

Response：

```json
{
  "status": "settled",
  "slot": "A",
  "transactionHash": "0x...",
  "explorerUrl": "https://sepolia.etherscan.io/tx/0x...",
  "tokenIn": "USDC",
  "tokenOut": "WETH",
  "makerWethDeltaAtomic": "-1000000000000000",
  "makerUsdcDeltaAtomic": "2500000"
}
```

Guard rejection 回傳 status blocked、實際 transaction hash／receipt 與安全的 revertReason。若請求在 broadcast 前失敗，使用非 2xx response，前端只顯示錯誤，不顯示 blocked evidence。

## Required invariants

- decisions 必須剛好包含 A 與 B，且只允許一個 slot。
- chainId、network、token pair、strategy hash 與 Explorer URL 必須來自同一個 deployment。
- sequence 必須遞增；expiresAt 必須對應 Guard 接受的 report。
- transactionHash 必須能由獨立 RPC 查到 receipt。
- settled 必須附 Maker balance delta；blocked 必須證明 token balances 沒有改變。
- service 不得把 private policy、Provider thresholds、模型輸出 chain of thought 或秘密來源回傳前端。

