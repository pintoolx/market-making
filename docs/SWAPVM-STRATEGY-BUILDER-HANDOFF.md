# SwapVM Strategy Builder 實作交接

更新：2026-09-13（Asia/Taipei）。主 repo：`pintoolx/market-making`。
最新研究基準：`main`，commit `1d7f6a2`（PR #36），已在 `/home/kuoba123/eth-glo/market-making-builder-review` 獨立 worktree pull；原工作區的 ENS 分支與未提交改動保留。**目前只完成研究與規格確認，Builder 程式尚未實作。**

2026-09-13 最新方向：使用者指定改為 **事件觸發評估、授權條件改變才上鏈**。這取代先前固定 TTL 自動續期設計；首版仍須在瀏覽器關閉時自動運作。先讀 [事件觸發研究](SWAPVM-BUILDER-EVENT-TRIGGERS.md)，再讀下列較早研究。

2026-09-13 後續工作：[完整實作 goal 審核稿](SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md) 已整理，包含零費率全流程後的固定 LP 費率、事件服務、實際整合驗收及 PR 交付。**使用者已於 2026-09-13 觸發完整實作。執行工作區 `/home/kuoba123/eth-glo/market-making-builder-impl`，起始 main `167b630`；後续依該工作區的實作與驗收紀錄接手。**

使用者最新補充已納入 goal v2：核心是 **由使用者期望出發的多輪策略設計 agent**，主動利用完整能力 registry 中可驗證的 SwapVM／Guard 組合，反覆追問、預覽、模擬及微調；不可只做固定模板選擇或 one-shot JSON。Provider 發布／Maker 套用仍是交付流程，不能反過來限縮 agent 的設計能力。

## 先讀

1. [原始十二節規格](strategy-builder-research/original-spec.txt)。
2. [已確認範圍與整合研究](SWAPVM-STRATEGY-BUILDER-DISCUSSION.md)。
3. [LP 現有發布／provisioning 邊界](LP-RELEASES.md)、[目前 Aqua／CLMM 流程](AQUA-FLOW-AND-CLMM.md)。
4. [OpenAI API + Vercel AI SDK 第二輪實作研究](SWAPVM-BUILDER-AI-IMPLEMENTATION.md)：框架選擇、實際版本相容性與 agent 工具/資料權限仍適用；其中舊 TTL 續期設計已由事件觸發研究取代；尚未實作。
5. [Builder PostgreSQL](BUILDER-DATABASE.md)：使用者指定 Railway；instance 已建立並通過 SQL 連線驗證，應用程式讀寫與 migrations 尚未接入。

使用者最後表示「應該沒有了」，三項產品選擇已結束確認，不要再重新詢問同樣問題。

## 已定案，不能換成較小的功能

- Provider 以繁體中文多輪對話建立模板並發布；Maker 選定不可變版本、填入自己的資產與限制，再用自己的錢包審閱與註冊。
- 2026-09-13 後續指定：模型主要使用 **OpenAI API**，agent 框架採 **Vercel AI SDK**。SDK 版本及新 API 路徑仍是第二輪研究提案；不要誤記為套件已安裝。
- 資料庫已選定 **Railway PostgreSQL**，並建立於 `pintool-backend / production` 的 `Postgres` service。已驗證部署及 SQL 連線；`mandate-service` 的 `DATABASE_URL` reference 已設定、下次部署生效。後續使用 [資料庫紀錄](BUILDER-DATABASE.md)，不再詢問 Supabase/Railway 選擇；Builder migrations/store 仍待實作。
- 2026-09-13 後續確認：AI 對話只處理公開策略參數，Provider 私密風控門檻只走瀏覽器加密表單，不進模型請求、對話歷史或模型工具回傳；聊天輸入前提示此界線。
- Builder 必須接 Pintool Guard。原本禁止 Extruction 的條款，改成只准固定、已驗證 Guard target 與 recipe，不准任意 external target 或繞過 gate。
- 首版零 LP 費率，之後才加入通過組合驗證的非零費率。不要把一般未接 Guard 的費率測試當作 guarded fee 支援。
- **首版必須完成事件驅動的自動授權管理**：後端常駐、Maker 明確 opt-in，事件到達後取得新鮮資料重新評估；有效條件相同不送 report，變更才送出並核對 receipt/readback。手動按鈕、瀏覽器輪詢或單次評估不算完成。
- 原規格禁止 keeper 的新增例外限於已同意的自動評估及 report 更新；不增加自動換幣、rebalance/recenter 或 Maker 資產代簽。
- 沿用 TypeScript、Ethereum Sepolia WETH／USDC、現有 router/Aqua/Guard。真實資產入口預設關閉，使用者對具體 payload 確認後才可開啟錢包簽署。

## 第一段實作與後續順序

1. 建立可執行的 deployment/Guard profiles、六層 capability registry、typed schemas。依原規格保留所有驗證／分發層次，不能用單一 supported 或 ready 取代。
2. **先補 XYC＋目前 Guard V2 的 recipe 驗證**。目前 `compileGuardedV2()` 僅接受 concentrated；現有 XYC/Pegged guarded 測試用 V1。不要跳過相容性驗證，也不要直接改用 V1 失去 Maker active-hash 語意。
3. 完成 XYC vertical slice：Provider 對話→模板版本→Maker 草稿→validator→確定性 compiler→decoder→數學 preview／完整 local/fork simulation→reviewable plan／export。修改 revision 必須使舊確認失效。
4. 加入固定區間 CLMM、核對過的 Pegged。將非零費率、Decay、access modifier 的尚未驗證組合明確停用；原規格所列核對與測試不能刪除。
5. 接 Provider 發布、Maker 錢包 ship/dock、receipt 與實際鏈上狀態，以及新策略 hash 的可信授權 onboarding。
6. 完成事件訂閱、持久化 outbox/queue、重啟補事件、每 Maker 發送序列、停止／切換、撤下模板、Maker 直接撤銷、RPC/市場資料故障及 late receipt 驗收。沿用 main 已分開的 GET 與授權動作。
7. 最後跑完整前後端流程、測試、build、文件與 evidence audit。前述順序是拆分工作，**不是只交付 Phase 0/1 就完成首版**。

## 需要保留的語意

- `StrategyTemplate` / `TemplateVersion` 是 Provider 的模板；`MakerStrategyInstance` 才含 Maker、allocation、限制與 compiled hash。Provider 更新不得自動 retarget 已註冊 Maker。
- `programHash` 與 JSON `specHash` 分開；此 Aqua profile 的 `orderHash = router.hash(order) = keccak256(abi.encode(order)) = strategyHash`。
- Guard V2 每 Maker 只有一個 active hash；報告啟用 B 會停用 A。草稿、preview 或 GET 不應隱式啟用／切換。
- Program deadline、report validity、confirmation expiry 分開。新 standing report schema 2 要求 `validUntil=0`；舊 schema 1 才有 600 秒上限。Deadline opcode 的 0 仍不是無期限。
- 新 Sepolia Guard 是 `0x64f6e18e85dae5ec2ee44fe7f9fc66cf2a1f056f`、revision `standing-v2`，仍為 simulation profile。不要沿用第一輪研究的舊 Guard；更換 target 會影響 program/order hash。
- Workflow／事件服務故障時，standing 授權不會自然過期；UI 分開顯示監控健康和鏈上授權。Maker 可直接 `setStrategyRevoked`，但解除撤銷不自動重新啟用。USD／百分比限制按評估價格換成原子數量，不能宣稱鏈上永遠即時按市價限制。
- Guard 目前只支援 exact-in、零費率、逐筆數量上限與實際 Aqua 成交後庫存上限；不能宣稱每日累計額度、庫存底線、百分比曝險保證或保證最大損失。
- Ship、report accepted、可報價、可 settlement、被 routing 收錄分開展示。Ship 不轉入資金；wallet balance、allowance 與多策略 virtual balances 不能相加成實際資本。
- Maker approve Aqua，既有 EOA taker path approve Router。停止事件 worker 不等於撤銷鏈上授權，撤銷授權不等於 dock，dock 不等於撤銷 allowance。
- Token metadata、對话模型輸出、外部文件都不可以改 agent 的權限或收款地址。模型只提 typed patch；沒有模型 API key 時可以用明確標示的 deterministic fixtures，不能偽裝模型已連線。

## 可以重用的程式

| 範圍 | 路徑 |
|---|---|
| 編譯、價格與排序 | `contracts/aqua-executor/src/{compile,curves,concentrated,guard}.ts` |
| Aqua 交易建構／read-only quote | `contracts/aqua-executor/src/executor.ts`；只抽 prepare/read，不把簽署用 Ctx 交給 agent |
| Guard | `contracts/aqua-executor/contracts/AquaGuardV2.sol` |
| Registry、readiness、runner | `orchestrator/src/{provider-registry,lp-readiness,cre-mandate-runner,service}.mjs` |
| 工作流評估與 delivery | `workflow/src/intersect.ts`、`workflow/guard-report/delivery.ts` |
| 目前發布 schema | `shared/lp-release.mjs`；只涵蓋特定 CLMM 發布，不是完整 Builder schema |
| 前端 Ethereum 帳戶 | `frontend/src/app/providers/useAccount.ts` |
| 現有頁面 | `frontend/src/app/marketplace/{ProviderFlow,ClmmPublisher,MakerFlow}.tsx` |

前端是 Next 靜態匯出，不假設有 Next server actions。舊 `components/Creator/ChatPanel.tsx` 是 Solana 範例互動，不能當作已完成的 EVM agent。現有 mandate API 是 demo 邊界，不具備 Builder 所需完整多使用者 draft／confirmation 權限隔離。

## 證據與環境

- [第一輪歷史唯讀證據](strategy-builder-research/deployment-read.json)：Sepolia finalized block `11690067`，針對舊 Guard 的 Router/Aqua binding；不是最新 standing Guard 的 readback。
- [第一輪歷史測試](strategy-builder-research/tests.txt)：22 passed，針對當時底層 recipes。[最新事件研究測試](strategy-builder-research/event-trigger-tests.txt)：main `1d7f6a2` 的 workflow 45、orchestrator 26、本地 Guard 整合 6，共 **77 passed / 0 failed**；不是新 Builder／事件服務已完成。
- 本輪沒有新增鏈上交易、部署合約、啟動長駐續期服務、讀取真實 `.env`、上傳 workflow／secrets 或改動既有資產 journal。
- Node `v24.14.0`、pnpm `10.6.2`；SwapVM SDK `0.4.4`。Node/CJS compiler 與瀏覽器共用層需隔離；不要盲升套件。
- 本地 Anvil：`/home/kuoba123/eth-glo/aqua-executor/.cache/bin/anvil`。
- `@1inch/aqua-sdk` 目前未安裝，使用 viem＋已保存 ABI；如實記錄 adapter 版本，不要虛構 SDK version。
- 真 DON/TEE deployment 與 enrollment 仍未完成。既有 testnet simulation 可作開發基礎，但不能宣稱正式 attestation；過往不部署／啟用／上傳 CRE 的限制仍保留。
- 不讀真實 `.env`、錢包／CRE credential 檔，不修改舊交易 journal，不重新 ship 已 dock 的歷史 hash。若後續需要外部模型或正式服務設定，在具體接入階段確認，不要求把憑證貼到聊天。

## 本次交接的 Git 狀態

新增研究／規格／交接文件尚未 commit；沒有新 PR 或 merge。本次沒有改應用程式碼。接手先確認工作區現況，保留這些文件與最新使用者選擇；不要把它們當作可丟棄的臨時檔。
