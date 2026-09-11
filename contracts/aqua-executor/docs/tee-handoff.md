# 給 TEE 隊友的 Aqua 執行端介面

Aqua 執行端已在 **Base Sepolia（84532）** 跑通 approve → ship → swap → rebalance → swap → dock → revoke，共 13 筆交易成功。兩個策略均已 dock，maker 對 Aqua 的兩個 token allowance 都已歸零。

[部署與交易證據](base-sepolia-demo.md) · [部署地址](../deployments/84532.json) · [成功 run 的完整紀錄](../records/84532/2026-09-11T17-31-09-909Z.jsonl)

已提供 [JSON 執行入口與中斷恢復](execution-recovery.md)，實際 TEE 服務尚未串接。請讓 TEE 輸出以下型別，作為 `ship`／`rebalance` 請求的 `strategy`；執行端會驗證、編碼並執行，不需要修改固定參數產生器。

以下 `AquaStrategyParams` 介面全文取自 `src/types.ts`，另附它依賴的 `Hex` 型別：

```ts
export type Hex = `0x${string}`

export interface AquaStrategyParams {
  /** Pins the deployed router's opcode table and ABI (swap-vm v1.0.2, NOT swap-vm main). */
  schema: 'aqua-swapvm-v1.0.2'
  chainId: number
  maker: Hex
  /** Exact token list shipped, and later docked. */
  tokens: Hex[]
  /** Raw units, same order as `tokens`. */
  amounts: string[]
  program: {
    /** Constant product x*y=k with a flat fee taken from amountIn. */
    kind: 'xyc'
    feeBps: number
    /** Unix seconds. */
    deadline: number
    /** uint64. A new salt gives a new strategyHash, which is required to ship again after a dock. */
    salt: string
  }
  meta: { producer: 'fixed-params' | 'tee'; strategyVersion: number; paramsRevision: number }
}
```

以下 JSON **原樣取自成功 run 最後一行的 `strategies[0].params`**。地址是真實部署的測試代幣，amounts 使用最小單位。這是執行證據快照；該策略已 dock，整合時必須更新 deadline 和 salt，不能直接重新 ship 此份快照。

```json
{
  "schema": "aqua-swapvm-v1.0.2",
  "chainId": 84532,
  "maker": "0x32F79282124EaFc681601cDCa2883C672C72D340",
  "tokens": [
    "0x051a2cae44c673c576b75b5df6f8543bf5d5cc13",
    "0xa66378d3f585fd34e875cccea69061c46bce5ecc"
  ],
  "amounts": [
    "2000000000000000000",
    "5000000000"
  ],
  "program": {
    "kind": "xyc",
    "feeBps": 30,
    "deadline": 1789151470,
    "salt": "9720735114401419293"
  },
  "meta": {
    "producer": "fixed-params",
    "strategyVersion": 1,
    "paramsRevision": 1
  }
}
```

整合時的欄位約定：

- `chainId`、`maker` 和 `tokens` 使用目標鏈與該次部署的真實值。呼叫端須核對 chainId 與執行網路一致；目前 `compile()` 不會替你檢查。
- `tokens` 恰有兩個不同地址，`amounts` 依相同順序填入正整數字串。範例是 2 mWETH（18 decimals）和 5000 mUSDC（6 decimals）。
- `feeBps: 30` 表示 0.30%。`deadline` 是未來的 Unix 秒數，`salt` 是 uint64 的十進位字串；每次產生新策略都要使用新 salt，dock 後不能用相同 hash 重新 ship。
- TEE 產生資料時，把 `meta.producer` 設為 `tee`。`strategyVersion` 與 `paramsRevision` 保留供追蹤；它們和 `chainId` 都不會編入 SwapVM order，僅改這些欄位不會產生新策略 hash。
- 本版只支援 `xyc`。資金量由 Aqua 虛擬餘額限制，到期由 SwapVM deadline 執行；另有[鏈下損失監控](risk-monitor.md)，使用獨立 `RiskPolicy` 和外部價格來源，達到相對 HODL 的損失門檻即 dock。rebalance 時必須保留原始持幣基準；這不是鏈上保證的損失上限。既有 `AquaStrategyParams` 型別不變。
- Maker 對 Aqua approve，taker 對 router approve。Lifecycle 的 unsigned tx 介面是 `buildTx.*`；部署合約及給 taker 補 gas 仍直接用 maker 私鑰簽名，還沒有 unsigned 介面。

TEE controller 請使用 `executeRequest(ctx, deployment, request, options)`；每個新操作帶唯一 `requestId`，重試時沿用完全相同的內容。同一 session 首次 ship 傳入原始 `RiskPolicy`，之後的 rebalance 不得重設 policy。非 ship 請求帶上前次結果的 `expectedStrategyHash`，避免對錯誤策略執行。

持續監控使用 `watchExecution()`／`npm run execute -- --session <id> --watch`，搭配 `createChainlinkPrices()`。watcher 可恢復 pending request，並接續其他程序已確認的 rebalance；所有使用這組 maker/taker 的程序必須共用同一個 state directory。原先 `createMonitorSession()` 和 `npm run monitor` 沒有這個交易恢復 journal，不要與新 controller 同時簽名。詳見 [請求格式、回覆與操作限制](execution-recovery.md)。`meta.producer: 'tee'` 本身不構成 TEE attestation。

[原有測試網證據](risk-monitor-sepolia.md) 分別記錄真實行情與模擬行情，兩組都是 mock token 交易。新 controller 的中斷恢復另由本機 Anvil + SIGKILL + CLI restart 測試驗證，未宣稱是新的公開測試網紀錄。

這份文件可直接轉貼給 TEE 隊友；尚未代為發送。
