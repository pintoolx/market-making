# SwapVM Strategy Builder 完整實作 Goal（審核稿）

版本：2，2026-09-13（Asia/Taipei）。狀態：**使用者已於 2026-09-13 觸發完整實作，goal active**。本版納入使用者補充：以期望策略為起點，盡可能利用 SwapVM／Pintool Guard 的能力，支援持續多輪討論與微調。

使用者已觸發「開始進行整套 builder 的實作」。執行工作區為 `/home/kuoba123/eth-glo/market-making-builder-impl`，起始 main `167b630`、分支 `feat/strategy-builder-core`。完成狀態以實作與驗收證據為準；沒有指定 token budget。

**Goal 目標文字**

> 在 `pintoolx/market-making` 完成以使用者期望為中心的多輪策略設計 agent。使用者可用繁體中文描述策略目標、交易偏好與限制，agent 透過 OpenAI／Vercel AI SDK 主動查詢 SwapVM 與 Pintool Guard 能力，提出可驗證的組合、說明取捨、追問必要資訊，並依預覽與模擬結果持續微調同一份策略，直到使用者確認。完成 Provider 不可變模板發布與 Maker 套用／調整流程，經確定性驗證、編譯、反解及完整模擬後，由錢包審閱 approve／ship，取得可信 Guard standing authorization。XYC、固定區間 CLMM、Pegged 是必要起點；所有目標部署中已驗證可安全組合的能力都應能被 agent 發現與使用。先完成零費率全流程，再完成已驗證固定 LP 輸入費。以 Railway PostgreSQL 保存對話、策略意圖、版本與工作狀態，由常駐事件服務觸發 CRE 評估，條件改變才送 report，每筆成交仍由 SwapVM Extruction 檢查 Guard。完成撤銷／切換／dock、故障恢復、多使用者隔離、前後端與鏈上驗收、部署文件及逐批 PR review／merge；以多輪設計能否產生符合使用者已確認需求的可執行策略作為核心完成判準。

**規格依據與執行起點**

- 以本稿審核結果、[最新 handoff](SWAPVM-STRATEGY-BUILDER-HANDOFF.md)、[事件觸發研究](SWAPVM-BUILDER-EVENT-TRIGGERS.md) 為最新方向；其次為 [AI 實作研究](SWAPVM-BUILDER-AI-IMPLEMENTATION.md)、[第一輪研究](SWAPVM-STRATEGY-BUILDER-DISCUSSION.md) 及 [原始十二節規格](strategy-builder-research/original-spec.txt)。舊 TTL 續期設計已被取代。
- 已研究基準是 main `1d7f6a2`（PR #36）。執行開始時重新取得最新 main，讀取新增規格與差異，以隔離分支／worktree 實作，保存實際基準 SHA。保留原工作區的 ENS 修改，不 stash、reset 或覆蓋其他工作。
- 已建立 [Railway Postgres](BUILDER-DATABASE.md)；業務 tables、store、應用連線與 worker 尚未建立。前輪 77 個測試是既有功能證據，不計為本 goal 新功能已驗收。
- TypeScript、既有 Next 靜態前端／Cloudflare 與 Node orchestrator 架構優先沿用。模型 API 主要用 OpenAI，agent 框架只用 Vercel AI SDK；採一個受限 agent，不新增多 agent 業務框架。CRE workspace 保持自身 Bun/WASM 工具鏈。
- Ethereum Sepolia，使用已核對的 WETH／Circle USDC、Aqua、router 與 standing Guard。部署地址、source/opcode/ABI/binding 及依賴相容性在執行時重新核對並鎖定，不直接沿用研究中的版本數字當最新事實。

**完成後使用者能做的事**

| 使用者 | 完整行為 |
|---|---|
| 策略設計者 | 從自然語言期望開始，由 agent 主動提出可行機制與必要問題，逐輪比較／修改曲線、條件及限制；可保存、返回先前版本、繼續未完成的設計 |
| Provider | 將設計結果發布為不可變模板；私密風控在獨立加密表單設定；錢包簽署版本、發布及撤下 |
| Maker | 選定 Provider 版本後，可繼續用對話調整模板允許的參數與自己的 allocation／限制，取得預覽／模擬，審閱交易後註冊並啟用 standing 授權及事件管理 |
| 運作中的 LP | 瀏覽器關閉仍有常駐事件服務；相同授權條件不增加鏈上交易；變更、暫停或明確切換會經 report 更新及 readback 確認 |
| Maker 管理 | 查看註冊、授權、資金、行情新鮮度、最後評估、監控健康與分發狀態；直接錢包撤銷、解除撤銷後重新啟用、dock，必要時另行撤銷 allowance |
| 開發與維運 | 可重現建置、完整測試、SQL migrations、狀態恢復、結構化公開事件紀錄、部署／回退指引，以及每項產品能力的證據 |

**多輪策略設計是核心產品要求**

使用者不需要先知道 XYC、opcode 或 Guard report 欄位。Agent 從目標與限制推導可選機制；模板是設計結果的發布／重用形式，不是限制使用者只能選幾張固定卡片的理由。沿用 Provider 發布→Maker 套用的主要交付流程；同一使用者可以設計並套用自己的版本。

必要設計循環為：

```text
描述期望 → 整理目標／硬限制／偏好／未知事項
        → 查詢可用能力及相容組合 → 提出方案與取捨
        → 有針對性的追問 → 修改既有草稿並顯示差異
        → 驗證／預覽／模擬 → 使用者回饋 → 再次微調
        → 需求逐項對照確認 → 定稿／發布／錢包審閱
```

- 保存 `StrategyIntent` 與需求清單：每條有 stable ID、來源輪次、使用者是否確認、優先級／硬限制、對應機制、實際強制範圍、驗證結果與未滿足原因。修改一項不丟失其他限制；對話歷史不是唯一狀態來源。
- Agent 主動組合曲線、費率／deadline／其他經驗證 modifier，以及 Guard 的方向、單筆與庫存 caps、條件式政策評估、事件更新和撤銷機制。跨 SwapVM／CRE／Guard 的責任必須說明，不把 workflow 的價格判斷冒充 Guard 自身讀 oracle。
- 在有實質取捨時提出可比較方案，例如區間寬度、資金可用性、成交限制及更新延遲；保留候選 revision 與 preview。只在真正缺資訊／矛盾時追問，不固定問完一大份問卷才開始工作。
- 支援「沿用上次設定但改這一項」「再保守一點」「回到前一版」「換一種曲線比較」等自然語言。含糊偏好先轉成具體可審閱變更；若無法合理推定，問影響決策的問題，不能任意宣稱已變安全或保證收益。
- 每輪以最新 domain state 呈現差異、需求覆蓋與下一步；validator 或 simulation 失敗時，agent 解釋失敗原因並提出修正，繼續同一條設計對話。
- Maker 超出 Provider 允許修改範圍時，明確拒絕直接修改該 pinned 版本，說明另建自有版本的路徑；不得默默解除 Provider 限制。已註冊策略的調整產生新草稿和必要操作，不冒充原地更新。
- 使用者明確滿意、所有硬限制均有正確處理、剩餘差異已被使用者接受後，才可進入定稿。對話中的確認與具體資產交易簽署仍是不同步驟。

**「盡可能利用所有功能」的可驗收定義**

完整盤點目標 router 的指令表、traits、recipes、Guard 合約能力及 evaluator 可用政策條件；每項進入六層 capability registry，包含相容限制、來源與測試。Agent 的能力檢索依使用者意圖與目標 profile 取得相關項目，不能只在 prompt 硬寫三個 curve 選項。

| 能力來源 | Agent 應能設計的部分 | 實作要求 |
|---|---|---|
| SwapVM | 曲線、固定價格區間、已驗證 pegged 參數、固定 input fee、deadline，以及核對後的 modifiers／access | 宣告式參數與 composition 規則；動態能力列表；確定性 recipe compiler 與 decoder |
| Pintool Guard | 允許 Maker 買／賣、單筆 token 數量、實際 Aqua 成交後庫存上限、active strategy、standing／revoke | 方向語意與上限交集正確；review 卡說明實際強制範圍；不可繞過 gate |
| CRE evaluator | 依價格／波動條件選擇規則，決定方向／caps／paused，再按事件更新授權 | 接通既有 ordered rules 的條件／優先順序／fallback；以私密政策表單編輯及驗證，不只調整固定 envelope |
| Aqua／生命週期 | 資產配置、有限 allowance、ship／dock、資金與可成交性檢查 | 資金由 Maker 錢包控制；agent 解釋與準備操作，不持有資產私鑰 |

使用者要求的功能若在已批准產品範圍內、目標部署可執行且與 Guard 相容，只差 Builder 接線或組合驗證，應補上 adapter/schema/UI/測試後讓 agent 使用。不能僅因現成 wrapper 缺少就永久列為 unsupported。

若能力在部署中不存在、組合語意不成立、需要超出已批准範圍的合約／協議或有尚未解決的安全問題，記錄具體理由與可行替代；由使用者選擇是否接受取捨。不能默默刪除需求、假裝提供，也不承諾在一個 goal 內任意擴充所有上游功能。

私密政策界線保留：agent 可以引導公開目標及選擇機制；私密規則形狀、順序、門檻、解密 trace 不進 OpenAI。具體私密條件由瀏覽器的受保護編輯器設定，模型只收到最小必要的完成狀態；不返回密文／私密規則詳情。政策預覽／錯誤提供給有權限的使用者時也不能經由模型或公開 stream 洩漏。

**實作順序與各批完成條件**

每批整理成可獨立 review 的 commits／PR，數量可因相依性調整；下列次序與必要交付不因拆 PR 而縮減。

| 階段 | 必須交付 | 該階段的完成證據 |
|---|---|---|
| 0. 基準與能力 | 最新 main 整合；完整 SwapVM／Guard／evaluator 能力盤點、deployment profiles、六層 registry、StrategyIntent 與需求對照、工具鏈核對 | 固定區塊 binding/code 證據；能力可由 agent 查詢；每個排除項有原因，不只列三種曲線 |
| 1. 資料與權限 | PostgreSQL migrations/store、服務端登入／錢包 ownership、revision、冪等與 jobs 基礎 | 真 Postgres 的持久化、重啟、跨使用者拒絕、併發更新及 migration 驗證；舊資料不被覆寫 |
| 2. XYC 核心 | typed schemas、Guard standing profile 的 XYC recipe、validator、compiler、獨立 decoder、數值 preview、隔離模擬、export／plan | XYC 與實際上游 router／Guard 的雙向完整 lifecycle；bytes 可重現；未知指令／繞過 Guard 被拒絕 |
| 3. 多輪設計與 Provider | OpenAI adapter、AI SDK 串流、十二個受限工具、意圖／需求狀態、能力組合與候選比較、繁中草稿／diff UI、對話持久化、私密規則編輯器、模板發布／撤下 | 真 OpenAI 多輪設計 eval；模擬失敗後修正、返回舊版、能力選擇與需求覆蓋；私密資料不出現在模型／stream |
| 4. CLMM 與 Pegged | 固定區間 CLMM、已驗證 Pegged、各自的 Guard recipe／decoder／preview／模擬／模板 UI | 6/18 decimals、token 順序反轉、固定 snapshot、非 50/50 庫存、區間與極端值、雙向成功與拒絕案例 |
| 5. Maker 與可信授權 | Maker instances、錢包 review／有限 approve／ship／dock／revoke、receipt/readback、任意合法新 hash 的可信 onboarding | 從新建模板產生新 Maker hash，無人工編輯 catalog/config 即可取得授權；錯 owner／版本／hash／簽名／撤下被拒絕 |
| 6. 常駐事件服務 | PostgreSQL outbox／subscriptions／evaluation jobs、每 Maker 發送序列、行情及鏈上 adapter、健康事件、CRE HTTP adapter、change-only delivery | 相同條件零新增 tx、變更才發送、關閉瀏覽器仍運作；重啟／多 worker／reorg／漏事件／late receipt／停用及切換驗證 |
| 7. 零費率全流程 | 三種模型的完整 Provider→Maker→事件評估→Guard→成交／拒絕／取消；現有平台 testnet rollout | 全流程瀏覽器證據；新 instance 的 Sepolia report、成功成交、拒絕成交及停止後拒絕證據；明確標示 CRE simulation |
| 8. 固定 LP 費率與 modifiers | 在零費率全流程通過後，完成固定 LP input fee 的 gross/net／庫存／Guard 設計、三種模型組合測試及可用入口；核對 deadline、Decay、原生 access 的產品邊界 | 已啟用 fee recipes 的實際 settlement 與 caps 不可繞過；各 modifier 有 verified／blocked 決策和來源；需要新 Guard 時提出完整遷移方案 |
| 9. 最終交付 | 修正整合缺陷、完整 CI／browser／release 檢查、PR review／merge、部署與恢復指引、handoff | 所有必要驗收可追溯到最終 commit／profile／測試；已審核版本在目標環境完成驗證；未解決項目不被標成完成 |

階段 2、3 合起來是 XYC 的首個完整 vertical slice；先使 XYC 跑通再擴充曲線。階段 7 是第一個可發布的零費率版本，**不是整個 goal 結束**；固定 LP 費率仍在本 goal 內。涉及新合約的部分遵守下方部署邊界。

**資料與程式邊界**

保留原規格五個獨立 model：`StrategyDraft`、`ValidatedStrategy`、`CompiledStrategy`、`SimulationReport`、`TransactionPlan`；另加入 StrategyIntent／需求覆蓋／候選方案、Provider template/version、Maker instance、AuthorizationBinding、AutomationConsent、事件與 delivery 狀態。

- PostgreSQL 至少保存公開 conversations/messages、draft revisions、template versions、maker instances、artifacts、simulation jobs、transaction plans/confirmations、可信 bindings、automation consents、event subscriptions/inbox/outbox、evaluation jobs、deliveries 與 chain cursors。表名可依既有架構調整；資料責任不可混成單一 JSON blob。
- 新資料採專用 schema 或明確命名空間、constraints 與索引；測試使用隔離 database/schema。建立版本化 migrations、連線池與 transaction 邊界，驗證升級與 app rollback 相容性；不對使用者既有資料執行清空式回退。
- 密文與 commitments 走獨立受權限保護的儲存路徑；私密政策明文不存對話／一般 DB 欄位／log。Secrets 由既有服務機制配置，不要求貼入聊天。
- 純 schema、validator、decoder、summary 與 Node compiler adapter 分離；RPC、fork worker、模型、錢包與 CRE delivery 各有明確介面。任何 Node-only executor context 不可傳給瀏覽器或模型。
- 新授權 binding 綁定 Provider 簽名版本、Maker consent、spec/recipe/profile digests、programHash、orderHash、chain/router/Guard、envelope commitments、revision/generation；服務端重新編譯及反解驗證。既有 workflow 的 trusted binding 檢查不得直接刪除。
- Simulation adapter 每個 job 使用隔離的已驗證 binding/config snapshot；正式 gateway adapter 也驗證授權來源。支援新 hash 不等於接受任意未核准 hash。

**AI 與前端的必要驗收**

原規格十二個 application tools 全部完成：`getCapabilities`、`resolveTokens`、`getWalletInventory`、`createOrPatchDraft`、`validateStrategy`、`compileStrategy`、`previewScenarios`、`simulateLifecycle`、`prepareRegistration`、`inspectStrategy`、`prepareCancellation`、`exportStrategy`。

- Provider 對話不追問尚不存在的 Maker 資產；Maker 套用時才固定自己的 wallet/allocation。每輪呈現需求與策略摘要、已知／缺少欄位、不支援項目、強制範圍及下一步。
- 模型只提出 typed patch，服務端決定權限及 domain state；每次工具執行核對 owner、revision、stage、profile。每個錯誤有可處理的結構，不能用模型文字宣告成功取代 artifact。
- 實質修改產生新 revision/diff，使舊 simulation、artifact 及尚未廣播的交易確認失效；已廣播交易繼續追蹤，不能以 revision 假裝撤回。
- 「上下 5%」固定資料來源、時間及 Maker 實例化時的具體上下價；不自動跟價。每個需求分類為 `onchain_enforced / preflight_only / informational / unsupported`，由 validator 判定。
- 前端完成 Provider Builder、模板列表／版本詳情、Maker 套用與我的策略／監控／取消。沿用既有導航和登入；執行時與最新已合併 ENS 功能相容，名稱顯示不覆蓋 pinned identity。
- API 驗證登入、錢包 ownership、request idempotency 及資源權限；對話／模擬設合理限制。禁止信任 client 自帶 system/tool history 或 owner。
- 真 OpenAI eval 至少涵蓋繁中多輪、修正參數、缺參數、不支援需求、惡意 metadata、工具選擇及錯誤恢復。Fixtures 用於離線回歸；沒有真 API 驗證時，該項保持未完成。
- 多輪驗收必須跨多次需求修改與工具回合，覆蓋：模糊意圖轉具體方案、XYC／CLMM／Pegged 選擇、SwapVM＋Guard 複合要求、前後要求矛盾、模擬不通後修正、回退／換方案、重新開啟對話與舊確認失效。單次完整 prompt 直接生成 JSON 通過不算多輪驗收。
- 驗收以最終草稿及 decoded program／policy binding 的需求對照為準：每條使用者已確認的硬限制都必須被滿足、明確拒絕或經使用者接受替代；不能用對話輪數或模型說「符合需求」代替。
- 發布簽名、Maker 資產簽署及 automation opt-in 都由明確 UI/action 完成，不由 LLM 發送。API key 不進前端；Provider 私密風控不進模型請求或工具回傳。

**事件行為的必要驗收**

首版以常駐 worker 接收事件，再經 CRE HTTP adapter 重新評估；不要求新增 CRE 原生 EVM log workflow 才能完成。後續若要換入口，不得重複發布相同來源的事件。

| 輸入或情境 | 必須驗證的結果 |
|---|---|
| Maker 首次啟用、明確切換、修改限制 | 核對當前 binding/consent；需要 program 改變時回到編譯／錢包流程，不能原地改已註冊策略 |
| 公開行情更新 | 事件只負責喚起評估；workflow 取得可信新鮮資料、運算私密政策；不相信任意 webhook 的 price/report |
| 相關 token／Aqua／Guard logs | 依 Maker／策略過濾，保存 block hash、tx hash、log index 與 cursor；同筆通知去重、重連補漏、處理 reorg |
| 條件相同 | 不呼叫鏈上寫入；保留原 report identity，更新本次評估時間與結果 |
| 條件改變 | 比較完整有效授權欄位及 active hash；成功 receipt 加 Guard readback 後才顯示生效 |
| 無新事件 | 不為延長時間而週期性發 report；資料取得／health check／漏事件 reconciliation 可有 timer，但不得成為 TTL 續期 |
| Provider 撤下 | 本稿採撤下受影響版本後，停止新套用，為已同意此條款的既有實例排入 paused delivery；UI 追蹤實際生效，不能只隱藏列表 |
| Provider 發布新版本 | 既有 Maker 繼續 pinned 原版，不能自動換 hash 或放寬限制 |
| 資料 stale／中斷 | 健康狀態轉換產生事件；依 consent 嘗試暫停。目前授權可能仍有效，不能顯示已停用或捏造自動到期 |
| 資料恢復 | 取得新鮮資料後重評；只有 consent 仍有效、未撤銷、未 dock、仍為 Maker 當前選擇時才可恢復 |
| Maker 停止／revoke／dock | 停止與取消語意分開；未廣播 jobs 失效，已廣播 jobs 繼續 reconcile。直接 revoke 由 Maker 錢包執行，不依賴 worker |
| A/B 切換及延遲工作 | 每 Maker 序列化，發送前重新核對 generation；B paused 不冒充 A paused；重試不能重新啟用已撤銷或過時 hash |
| 多 worker／timeout／重啟 | 持久化 lease、request ID、report nonce、pending tx；未知 receipt 先對帳再重試。共用 broadcaster 時另處理 tx nonce |
| 自己送出的 report 事件 | 作為 receipt／狀態更新，不產生無窮重評或互相切換；事件重播不重複副作用 |

不能把「事件只處理一次」當作鏈上天然保證；以去重、狀態驗證與 reconciliation 保證可重試操作的業務結果。價值上限按評估價格換成原子數量，行情到新 report 生效有延遲；第一版精確比較有效條件，不默默忽略會收緊上限的價格變動來省 gas。

**合約、模擬與錢包的必要驗收**

- 全部產品 recipes 固定已驗證 Guard Extruction target、合法位置與 envelope；未知 opcode／reserved gap／traits／長度／hooks／jump／任意 target 直接拒絕。每筆 quote/swap 維持同步 gate，事件系統不替代它。
- 原子數量、價格平方根、排序與 fee encoding 使用 bigint／已驗證精確算法；JSON 大整數為十進位字串。測試 6/18 decimals、反轉排序、反轉價格上下限、捨入、極小／極大數值與 snapshot 可重現性。
- `specHash`、`programHash`、`orderHash`、`strategyHash` 分開；依實際 Aqua profile 記錄 orderHash 與 strategyHash 的正確關係。相同 spec/manifest/recipe/salt 產相同 bytes，decoder 獨立核對語意。
- 三層結果分開：數學 preview、固定 context quote、完整 settlement simulation。Evidence mode 保留 `mock / local-upstream / fork-with-overrides / fork-real-context / live-read`，不得把 mock 報成 live。
- 未 ship 的策略在隔離 local/fork 建立所需狀態；simulation worker 的寫入只可到隔離 chain，不能誤送 public RPC。量測 quote/swap 時保持相同起始 state/time/caller。
- 三種模型測雙方向 exact-in、低庫存、連續成交、曲線邊界、實際 transfer path、失敗後餘額不變、deadline 前後、dock 後失效。Exact-out 在目前 Guard profile 要驗證拒絕，不能只標示未測。
- Standing report 驗證超過舊 600 秒／時間推進一小時後仍有效但 caps 不變；schema-1 的到期行為保持相容；Maker revoke/unrevoke、active 切換、缺失／錯 domain／錯 pair／超 caps 都有拒絕證據。
- 交易卡從 decoded payload 產生 chain、maker、target、selector、params、calldata digest、value、spender、有限 allowance、gas 估計與前置條件；核對 manifest/revision 與簽名前狀態。
- Maker approve Aqua、現有 EOA taker path approve Router；WETH 與原生 ETH 分開，不默默 wrap。拒簽、錯鏈、revert、timeout、replacement、重試及 receipt/readback 失敗均有可恢復狀態。
- 分開顯示 wallet/allowance/virtual balances/其他 commitments；不把 ship 當入金，不重複計算 shared inventory。註冊、report accepted、quote、settlement、routing 各自有狀態。

**費率及能力邊界**

固定 LP input fee 是本 goal 的必要後段交付，先寫出 gross input、net pricing input、實際 Aqua credit/debit、Maker 收入、單筆／庫存 caps 的一致性規格，再啟用 UI。XYC／CLMM／Pegged 的已開放含費 recipe 都要做雙向、邊界、連續成交及超額拒絕測試；沿用未接 Guard 的含費測試不算驗收。

如現有 Guard 無法正確支援，先完成候選 Guard 修改、ABI/profile/compiler/decoder 配套與本地／fork 測試，再提出可 review 的部署和舊 hash 遷移方案。未完成必要合約／部署驗收時，費率維持停用且 goal 的費率項目未完成；不能自行將它移出 goal。

Deadline 要驗證實際支援語意；report 的 `validUntil=0` 不代表 deadline opcode 的 `0` 是無期限。若要提供無 program deadline，先驗證省略該指令的 recipe，再開放選項。

Decay、原生方向／access modifiers 必須完成對 pinned source、編碼、組合和分發的核對；與 Guard 經測試相容者才 product-enable，其他保留明確 blocked 原因。它們是有條件啟用項，不能以 unchecked 支援充數。Protocol/dynamic fees、特殊 token 行為、exact-out、resolver／聚合器收錄、自訂 opcode/router/AquaApp、任意 hooks、rebalance/recenter/DCA、跨協議資產操作維持範圍外。

**交付與實際環境驗證**

- 目標包含既有 Cloudflare 前端、Railway API／常駐 worker 與已建立 Postgres 的應用整合。先完成可 review 的 build、migrations、環境範本、health/readiness、feature flags 與回退路徑，再依已批准範圍 rollout；新 Builder 不自動改動既有 Maker positions。
- 模擬工作與常駐事件工作可用不同 process／service，資源互相隔離；部署時不把所有 worker 放在瀏覽器或只有請求期間才存活的流程。
- 零費率 Sepolia 驗收至少覆蓋新模板及新 Maker instance 的 report 接受、unchanged 無新 tx、條件改變、新策略成功成交、拒絕成交、revoke／dock 後不可成交。三種模型都要有完整 lifecycle 證據；部署 profile 必須與 local/fork 的來源對上。
- 事件 worker 需有瀏覽器關閉、重啟恢復和持續運作證據；額外以本地時間推進與注入事件測試故障序列。不能只演示手動按一次重新評估。
- 保留 CRE simulation 與正式 DON/TEE 的區分。此 goal 可以在明確標示的 Sepolia simulation profile 完成交付；正式 CRE workflow 上傳／部署／啟用不在此稿授權範圍，沿用使用者先前限制。
- 交付 README／啟動指令、環境範本、API/schema、capability/profile、支援／拒絕示範、測試報告、部署及資料恢復指引、限制與來源、授權條件核對及更新 handoff。

**外部依賴與批准邊界**

| 依賴 | 處理方式／對完成的影響 |
|---|---|
| OpenAI API | 真模型串流與 eval 需要服務端可用憑證及帳號額度；執行時查可用設定，不讀出秘密。缺少時完成其餘 core／fixtures，真模型項目保持未完成 |
| Privy、Railway、Cloudflare | 重用既有專案設定；需要新 secret 時只請使用者在服務平台設定。連線／部署不可用時保留具體 blocker，不把 local 成功當 cloud 成功 |
| Sepolia 測試錢包／資金 | 實際 wallet flow 由使用者簽署，或使用其另外明確授權的測試帳戶及操作範圍。事前列明具體交易與資金需求；不要求貼私鑰，不動用未授權主網資金 |
| 固定費率可能需要新 Guard | 本地程式與測試先完成；新的公開鏈合約部署／舊策略遷移需要可審閱的地址／payload／成本方案。沒有該批准前保持該項未完成，繼續其他可做工作 |
| 正式 CRE DON/TEE | 不是目前 simulation profile goal 的前置條件；不代替正式 attestation，也不擅自解除既有禁止部署／啟用／上傳的限制 |

本稿通過並被觸發後，預定的程式工作範圍包括：隔離分支開發、必要依賴／migrations／設定、測試、逐批 commits、PR、自行 review 並修正、CI 通過後 merge，以及上述既有應用平台的 Builder rollout。額外收費服務／權限擴張、新公開鏈合約部署及使用者資產簽署仍依前述具體範圍處理；本稿本身不構成已取得這些批准。

**Goal 最終完成條件**

1. 使用者可從期望開始，經多輪追問、能力組合、預覽／模擬和微調得到自己確認的策略；最終需求覆蓋、版本與執行結果可追溯。固定模板選擇器或 one-shot JSON generator 不算完成。
2. Provider 發布、Maker 套用、三種曲線、固定 LP 費率、錢包註冊／取消、可信新 hash onboarding 與事件服務均有實作及對應驗收。
3. OpenAI 真實請求、Postgres 真實持久化、瀏覽器完整流程、部署環境健康及 Sepolia lifecycle 均有證據；受限／不支援能力如實展示。
4. 事件觸發與 change-only report、每 Maker 切換順序、standing 故障行為、直接撤銷和重啟恢復通過測試；沒有待追蹤卻被當作成功的交易。
5. 相關 build/typecheck/test/CI 通過；review 發現的正確性、權限或資金風險問題已修正；合併後確認的是最終版本，沒有以舊測試結果代替新變更驗證。
6. 完整交付文件、測試／交易／部署 evidence 與 handoff 已入 repo；所有 scope 內 PR 已完成 review／merge，必要 rollout 已驗證。

外部依賴或部署批准未到位時，繼續完成不依賴它的工作並清楚記錄剩餘項目；不能標記整個 goal complete。只有使用者另行明確調整範圍，才可修改上述完成條件。規劃核准後不在每個普通實作步驟重問同一選擇。
