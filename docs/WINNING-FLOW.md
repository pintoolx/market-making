# ETHOnline winning flow: Confidential Strategy Mandate

狀態：2026-09-12 團隊主線。這份文件定義唯一 demo、跨模組語意與驗收證據。舊版 USDC／USDT Toxic-Flow Shield 僅保留為 Defensive Strategy 的研究來源，不再是作品題目。

## 一句話

PinTool lets two Strategy Providers compete for one Maker balance without revealing their trading logic or the Maker's private risk limits.

## 為什麼需要 Chainlink 與 Aqua

- Chainlink Confidential Workflow 在 TEE 內讀取 Provider A、Provider B 與 Maker 的私密條件，產生短效 mandate。
- PinTool 的 deterministic validator 保證 Provider 結果只能收緊 Maker 硬上限。
- PinTool Guard 在每筆 SwapVM 執行時檢查最新 mandate。
- Aqua 讓兩套已 ship 的策略共用同一份 Maker wallet balance；regime 改變時不需要先搬移資產。

鏈上可看到 active strategy、額度、期限、commitment 與交易。Provider signals、thresholds、feature weights，以及 Maker 原始風險限制不得離開 TEE。

MVP 若只能使用 workflow owner 預先配置的 Vault DON secrets，必須如實描述。網站表單內容在證明端到端加密路徑前，不得宣稱已直接送入正式 TEE。

## 固定情境

- Network：Ethereum Sepolia。
- Pair：WETH／Circle testnet USDC。
- Strategy A — Tight Market：WETH／USDC concentrated program；Provider A 在低波動狀態採較窄 price range，提高區間內資金效率。
- Strategy B — Defensive Market：相同 pair 與 compiler 的 concentrated program；Provider B 採較寬 price range、較低 per-fill 與 inventory caps，承受較大價格移動時降低單筆曝險。

兩套 definition 都使用 pinned SwapVM v1.0.2 的 Concentrate → XYC program、AquaGuardV2、零 LP fee 與同一個 Maker wallet。實際 sqrtPrice bounds 必須由錄影 market fixture 透過 `concentrationBounds()` 產生，不在前端手填。Guarded concentrated template 目前要求零 fee；Provider performance fee 不得混入 SwapVM LP fee。
- Maker mandate：capital budget、maximum WETH exposure、maximum WETH inventory、maximum fill、expiry。
- Base Sepolia 的 mWETH／mUSDC 部署只保留為歷史回歸證據與 fallback，不作 final filmed run。

測試市場狀態必須標明為可重現 fixture，不能宣稱是 live market data 或收益證明。

## 唯一 demo 閉環

### Normal regime

1. Provider A 與 B 的 policy 已配置為 confidential workflow secrets。
2. Maker 提交私密 mandate。
3. handlerInTee 取得三份秘密與 normal-market fixture。
4. Agent 產生結構化候選，deterministic validator 套用 Maker 硬上限。
5. CRE 將短效 mandate 寫入 Guard：activeStrategyHash = A。
6. 使用同一 Maker wallet：
   - Strategy A 的 Aqua swap 成功並產生 ERC-20 transfer。
   - Strategy B 的 Aqua swap 被 Guard revert，Maker 餘額不變。

### High-volatility regime

1. 同一 workflow 以 high-volatility fixture 再執行。
2. 新 sequence 原子地將 activeStrategyHash 從 A 切成 B。
3. 使用同一 Maker wallet：
   - Strategy A 被 Guard revert。
   - Strategy B 的 Aqua swap 成功。
4. 前端並排顯示兩次 report、strategy hashes、交易 receipt 與 Maker balance delta。

## 2–4 分鐘影片

1. **0:00–0:25 — Problem**：Aqua 讓一份餘額支援很多策略，但 Maker 不知道哪個私密策略此刻可以安全使用資金。
2. **0:25–0:55 — Two-sided privacy**：展示兩個 Provider commitment 與 Maker 私密 mandate；不展示原始內容。
3. **0:55–1:25 — Confidential decision**：CRE CLI 證明 handlerInTee 執行，logs 不含秘密；Guard 收到 sequence 1。
4. **1:25–1:55 — Normal execution**：A 成交、B revert，顯示同一 Maker address 與 token balance。
5. **1:55–2:25 — Regime transition**：市場 fixture 改變，sequence 2 將 active strategy 切到 B。
6. **2:25–3:05 — Enforcement reversal**：A revert、B 成交；顯示真實交易與餘額。
7. **3:05–3:25 — Close**：private intelligence、private risk limits、shared self-custodial liquidity、verifiable enforcement。

## 必須統一的方向語意

合約與 API 使用 taker 視角的 tokenIn → tokenOut；產品畫面同時顯示 Maker 的餘額結果。不得只寫 buy／sell。

- Taker WETH → USDC：Maker 收到 WETH、付出 USDC。
- Taker USDC → WETH：Maker 收到 USDC、付出 WETH。

## Mandate v2 的最低欄位

- schemaVersion、chainId、guard、router、maker
- activeStrategyHash、strategyAHash、strategyBHash
- sequence、validAfter、validUntil、allowedDirections
- maxWethPerSwap、maxUsdcPerSwap、maxPostWethBalance、maxPostUsdcBalance
- providerACommitment、providerBCommitment、makerPolicyCommitment
- marketSnapshotId、decisionDigest

所有金額以 atomic integer 字串傳送，時間為 Unix seconds。Report 必須綁定 chain、Guard、router、Maker、兩個完整 program hash、sequence 與期限。

### 為什麼不能直接沿用 GuardReportV1

目前 AquaGuardV2／GuardReportV1 仍以 (maker, strategyHash) 分別更新 concentrated strategy。它可證明單一策略的方向與額度 enforcement，但無法用一筆狀態更新原子地切換 A／B。主 demo 需要 Maker-scoped activeStrategyHash，或一個可原子更新兩套狀態的 batch report。不得用兩筆彼此獨立的 report delivery 假裝沒有中間狀態。

## 前端狀態機

CHOOSE_TWO_PROVIDERS → PRIVATE_MANDATE → REVIEW → TEE_EVALUATING → MANDATE_ACTIVE → SWAP_A_SETTLED + SWAP_B_BLOCKED → REGIME_REEVALUATING → MANDATE_SWITCHED → SWAP_A_BLOCKED + SWAP_B_SETTLED

前端不得以 setTimeout 產生 approved、active、settled 或 blocked。每次前進必須由 workflow response、contract read、confirmed receipt 或 revert receipt 觸發。

## 各人最小交付

### Confidential workflow

- 程式碼必須 push 進本 repo 的 workflow branch。
- 真實註冊並使用 handlerInTee，至少讀取一項 Vault DON secret。
- Provider A、Provider B 與 Maker policy 經 deterministic validator 合成。
- 產生 normal 與 high-volatility 兩次可重現結果。
- 公開 logs 不含秘密；保留 CLI output 與 delivery receipt。

### Aqua／contracts

- 從 1inch 官方 Aqua／SwapVM source 部署或使用符合獎項要求的 official contracts。
- Ethereum Sepolia 使用 WETH 與 Circle testnet USDC。
- 同一 Maker wallet ship Strategy A 與 B。
- Guard 以一筆 state change 原子切換 active strategy。
- 保存 A success／B revert，切換後 A revert／B success 的 receipt 與 balance delta。
- Base Sepolia 證據保留作 fallback，不得混成 Ethereum Sepolia final evidence。

### Frontend／integration

- Maker 必須選兩位 Provider，再提交一份共同 mandate。
- 顯示 regime、active strategy、report digest、sequence、expiry、兩個 strategy hash、交易與餘額變化。
- API 或 evidence 缺失時顯示錯誤，不產生假成功。
- Provider 與 Maker 原始私密輸入不得出現在另一方畫面或公開 evidence。

## Go / no-go

錄影前必須一次跑過：

- [ ] repo 中可見真實 confidential workflow implementation。
- [ ] handlerInTee 讀取秘密且 logs 無洩漏。
- [ ] normal report 原子啟用 A。
- [ ] A swap 成功、B swap Guard revert。
- [ ] high-volatility report 原子啟用 B。
- [ ] A swap Guard revert、B swap 成功。
- [ ] 四筆結果都能由 receipt 與 Maker balance 獨立驗證。
- [ ] 前端只由真實 evidence 前進。
- [ ] README 清楚區分既有 PinTool、Base fallback 與 ETHOnline 新成果。

少掉 confidential execution、原子切換或 Aqua 真實 transfer 其中任何一項，作品就還不是完整 sponsor 閉環。
