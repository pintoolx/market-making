# ETHOnline winning flow: Confidential Toxic-Flow Shield

> 2026-09-12 更新：這份流程保留為 **Defensive Strategy B 的測試 fixture**，不再是整個作品的題目。作品主線已收斂為 Confidential Strategy Mandate：同一個 Maker balance 支援兩套 Provider strategies，TEE 依雙方私密條件切換短效授權。決策依據與完整競品分析見 [TOPIC-DILIGENCE.md](TOPIC-DILIGENCE.md)。

狀態：Defensive Strategy B 的目標整合 fixture，定義方向語意、跨模組需求與驗收證據。本文的產品 JSON、`expectedSequence` 和 Ethereum Sepolia 範例，不等同目前已實作的 Guard ABI。第一步 CRE transport check 沿用 Base Sepolia 84532、mWETH / mUSDC、零費率 XYC 與 16 欄位 v1；完整雙策略及 sequence 約束尚待合約／workflow 一起整合。範圍對照見 [CRE-GUARD-INTEGRATION.md](CRE-GUARD-INTEGRATION.md)。

## 一句話

PinTool lets a Maker use a Provider's private risk intelligence to stop toxic flow without revealing either party's rules or giving up custody of liquidity.

## 固定情境

- Pair：USDC / USDT。
- Aqua position：Maker 以自己的錢包提供雙向流動性。
- Provider 的秘密：如何從價格、流動性與時間訊號判定 USDT 已有脫鉤風險，以及何時恢復報價。
- Maker 的秘密：最多願意累積多少 USDT、單筆上限、總額度及報告有效期限。
- TEE 的工作：結合兩方秘密與市場輸入，產生最小、可逐筆 enforce 的 Guard report。
- 公開結果：允許方向、逐筆上限、到期時間、版本與 commitment。原始門檻、權重及推理過程不離開 TEE。

這個策略不宣稱預測脫鉤或保證獲利。它證明的是：當 Provider 的私密模型判定風險成立時，Maker 的公開執行邊界會在不揭露原始規則的情況下收緊。

## 可重現的策略規則

第一版不讓 LLM 自由決定金額。Agent 只把 Provider 的自然語言規則整理成結構化候選，最後結果由 TEE 裡的確定性函式產生：

```text
providerCap = providerModel(marketSnapshot).maxUSDTInventory
effectiveCap = min(providerCap, maker.maxUSDTInventory)

allowMakerReceiveUSDT =
  reportIsFresh
  AND tradeUSDCValue <= maker.maxSwapUSDC
  AND maker.currentUSDTValue + tradeUSDCValue <= effectiveCap

allowMakerPayUSDT = reportIsFresh AND tradeUSDCValue <= maker.maxSwapUSDC
```

Maker 的硬上限永遠優先；Provider model 只能進一步收緊。若 token、版本、時間、數值或模型輸出不合法，採 fail closed。

### 錄影用固定 fixture

這些數字是可重現的測試輸入，不是收益承諾或即時市場資料：

| | Normal report | Risk report |
|---|---:|---:|
| USDT reference price | 1.000 USDC | 0.985 USDC |
| Provider 私密模型產生的 inventory cap | 600 USDC | 280 USDC |
| Maker 私密 inventory cap | 350 USDC | 350 USDC |
| Maker 現有 USDT value | 250 USDC | 250 USDC |
| Test trade | Maker receives 50 USDC value of USDT | Maker receives 50 USDC value of USDT |
| Effective cap | 350 USDC | 280 USDC |
| 結果 | 300 ≤ 350，Allowed | 300 > 280，Blocked |

同一份 risk report 下，再執行 `Maker pays 50 USDC value of USDT`，inventory 從 250 降到 200，因此 Allowed。這三筆檢查形成 baseline success、toxic-flow rejection、safe unwind success。

## 永遠使用 Maker 視角描述方向

禁止只寫 `buy USDT`、`sell USDT`、`USDC → USDT`，因為評審無法知道那是 Maker 還是 Taker 的視角。

| 畫面用語 | Taker 動作 | Maker 餘額結果 | 風險狀態下 |
|---|---|---|---|
| **Maker receives USDT** | Taker pays USDT and receives USDC | Maker 的 USDT 增加 | Blocked |
| **Maker pays USDT** | Taker pays USDC and receives USDT | Maker 的 USDT 減少 | Allowed |

## 2–4 分鐘影片的唯一閉環

### 1. Problem（0:00–0:20）

Maker 想使用專家的做市策略，但 Provider 不願公開訊號與門檻，Maker 也不願交出自己的資金限制。公開所有規則會洩漏 edge，把資金交給黑盒則要求過多信任。

### 2. Two private inputs（0:20–0:55）

1. Provider 在 Studio 發布 **Toxic-Flow Shield**，公開說明用途與收費；脫鉤判斷邏輯只送入 confidential workflow。
2. Maker 選取策略，輸入資金額度、最大 USDT inventory、單筆上限與有效期限。
3. 畫面只呈現各自可見的內容，不展示另一方原始輸入。

### 3. Confidential decision（0:55–1:25）

1. CRE 以 `handlerInTee` 解密兩方輸入。
2. Agent 或模型只能提出結構化候選決策。
3. 確定性 validator 檢查 Maker 硬上限、輸出 schema、時間與版本。
4. CRE CLI 顯示 confidential handler 成功執行；logs 不得含原始秘密。
5. 初始 report 允許雙向成交，Guard 收到 report 後發生鏈上 state change。

### 4. Baseline Aqua execution（1:25–1:50）

1. Maker ship 一個含 curve、fee 與 `Extruction(PinToolGuard)` 的 SwapVM strategy。
2. Test Taker 完成一筆真實 swap。
3. 畫面顯示 strategy hash、transaction hash 與 Maker 前後 token balance。

### 5. Risk transition（1:50–2:25）

1. 市場輸入顯示 USDT 偏離參考價格；測試資料必須清楚說明來源。
2. 同一個 confidential workflow 再次執行。
3. TEE 不公開 Provider 門檻或 Maker 上限，只輸出：`Maker receives USDT = blocked`、`Maker pays USDT = allowed`、上限與到期時間。
4. Chainlink report 更新同一個 Guard strategy state，畫面顯示 report digest 與 state-change transaction。

### 6. Prove enforcement（2:25–3:05）

1. Taker 嘗試把 USDT 賣給 Maker；Guard revert，Maker 沒有增加 USDT。
2. Taker 用 USDC 買走 Maker 的 USDT；Aqua swap 成功，Maker 的 USDT 減少。
3. 並排顯示失敗 receipt、成功 transaction 與前後餘額。

### 7. Close（3:05–3:25）

重申三個保證：Provider edge 保密、Maker policy 保密、資金始終由 Maker 自己保管。鏈上只保留足以執行與稽核的最小結果。

## 跨模組契約 v1

所有整數以十進位字串傳輸，時間為 Unix seconds，token amount 使用最小單位。不要使用 JS `number` 承載 atomic amount。

### TEE 輸入 envelope

```json
{
  "schemaVersion": "1",
  "requestId": "0x...",
  "chainId": "11155111",
  "maker": "0x...",
  "strategyHash": "0x...",
  "providerVersion": "1",
  "providerCommitment": "0x...",
  "makerPolicyVersion": "1",
  "makerPolicyCommitment": "0x...",
  "marketSnapshotId": "0x...",
  "issuedAt": "...",
  "nonce": "..."
}
```

Provider policy、Maker policy 與需要保密的市場回應透過 confidential input／secret 取得，不得塞進公開 envelope 或一般 logs。

### Guard report

```json
{
  "schemaVersion": "1",
  "requestId": "0x...",
  "chainId": "11155111",
  "maker": "0x...",
  "strategyHash": "0x...",
  "sequence": "2",
  "issuedAt": "...",
  "expiresAt": "...",
  "allowMakerReceiveUSDT": false,
  "allowMakerPayUSDT": true,
  "maxSwapUSDCAtomic": "100000000",
  "remainingUSDTCapacityAtomic": "0",
  "providerCommitment": "0x...",
  "makerPolicyCommitment": "0x...",
  "marketSnapshotId": "0x...",
  "decisionDigest": "0x..."
}
```

每次 quote／swap 的 `takerData` 必須攜帶 `expectedSequence`。Guard 只在它等於目前 report sequence 時執行；若 Chainlink report 在 quote 後更新，swap 必須以 `StaleMandate` revert，不能悄悄改用新參數。

合約層不要依賴 JSON。TEE adapter 必須把同一組欄位 ABI encode 成固定 struct，並由 report digest 綁定完整內容。

### Guard 必須拒絕

- caller 不是核准的 Chainlink Forwarder；
- workflow identity 不符；
- `chainId`、Maker 或 `strategyHash` 不符；
- `sequence` 沒有遞增；
- `takerData.expectedSequence` 與目前 report sequence 不符；
- report 已過期或 `issuedAt` 在不合理未來；
- report 放寬 Maker 隨 Aqua strategy ship 的硬上限；
- swap 方向被關閉；
- swap amount 或成交後 inventory 超過有效上限。

## 前端狀態機

```text
POLICY_INPUT
  → POLICY_REVIEW
  → TEE_EVALUATING
  → APPROVED | REJECTED
  → AWAITING_MAKER_SIGNATURE
  → AQUA_ACTIVE_NORMAL
  → BASELINE_SWAP_SETTLED
  → RISK_REEVALUATING
  → GUARD_REPORT_UPDATED
  → TOXIC_SWAP_BLOCKED + UNWIND_SWAP_SETTLED
```

前端不能再用 `setTimeout` 把狀態自行變成成功。每次前進需由以下其中一種真實證據觸發：CRE CLI／workflow response、wallet signature、transaction receipt、contract read 或 revert receipt。

## 各人最小交付

### Confidential workflow

- 真實註冊並使用 `handlerInTee`。
- 至少處理一項真實 sensitive input。
- 輸出 v1 report；敏感值不出現在 console、error 或 public report。
- 提供 normal 與 risk 兩次可重現執行。
- Agent 輸出後必須經 deterministic validator，不讓自由文字直接控制資金。

### Aqua／contracts

- 官方 Aqua／SwapVM contract 或允許的 redeployment。
- Maker ship 的 program 包含實際 curve 與 Guard Extruction。
- Guard 可接收 report 並更新鏈上狀態。
- 一筆 baseline token transfer 成功。
- risk report 後，一筆 Maker receives USDT 失敗、一筆 Maker pays USDT 成功。
- 保存所有 hash、receipt 與前後 balance。

### Frontend／integration

- 使用同一組方向語意，不顯示含糊的 buy／sell。
- 以真實 receipt 驅動畫面狀態。
- 顯示 report digest、Guard update tx、Aqua strategy hash、swap tx 和 balance delta。
- Provider 與 Maker 原始私密輸入不可出現在另一方頁面或公開 evidence。
- 失敗是正式產品狀態：顯示 Guard 拒絕原因類別與餘額未變，不顯示假 transaction hash。

## 最終 go / no-go

錄影前必須一次跑過：

- [ ] CRE CLI 證明 confidential handler 真實執行。
- [ ] normal report 改變 Guard state。
- [ ] 官方 Aqua／SwapVM 參與實際 token transfer。
- [ ] baseline swap 成功且餘額改變。
- [ ] risk report 再次改變 Guard state。
- [ ] Maker receives USDT 被 Guard revert，餘額不變。
- [ ] Maker pays USDT 成功，Maker USDT 減少。
- [ ] 公開 logs 與 UI 找不到 Provider／Maker 原始秘密。
- [ ] README 清楚區分既有 PinTool 與本次新增成果。

少掉前六項中的任何一項，影片就只是在展示 UI 或彼此獨立的 sponsor integration，不構成得獎閉環。
