# Aqua 策略深入研究：哪些限制能逐筆生效

日期：2026-09-11。接續 [AQUA-MAKER-RESEARCH.md](AQUA-MAKER-RESEARCH.md)。上一輪列了六個方向，留下的問題是：候選策略裡，哪些條件 Aqua 能在每一筆成交時強制執行，哪些只能靠 TEE 定期檢查。這決定了 demo 能宣稱什麼。

這輪直接讀原始碼與官方文件，沒有做鏈上交易、回測或實際跑 TEE。

## 一、查證結果

### Aqua 部署版能用的指令

來源：`1inch/swap-vm` `contracts/opcodes/AquaOpcodes.sol`（commit `afd99c4`，2026-09-09）。

| 能用 | 不能用（原始碼有，但 Aqua 路由器沒註冊） |
|---|---|
| XYCSwap、XYCConcentrateSwap、PeggedSwap、Decay | OraclePriceAdjuster（依預言機調價） |
| FeeFlatIn、FeeProtocol | MinRate（最低成交價） |
| Deadline、Salt、Jump、JumpIfTokenIn、JumpIfTokenOut | LimitSwap、DutchAuction |
| OnlyTakerTokenBalance 系列、OnlyTxOriginTokenBalanceNonZero | BaseFeeAdjuster、Whitelist |
| **Extruction** | |

重點：**Aqua 上沒有內建的預言機調價與最低成交價。** 想讓外部資訊影響成交，只剩 Extruction 這一條路。

### 策略上架後不能改

來源：`1inch/aqua` `src/interfaces/IAqua.sol`（commit `9c5c42e`）。同一個 strategyHash 再上架會報 `StrategiesMustBeImmutable`；上架（ship）與下架（dock）都由 Maker 本人呼叫。

所以程式裡寫死的參數（曲線、區間、費率、錨定比例）要改，只能讓 Maker 下架再上架，也就是每次都要 Maker 簽名。

### Extruction：成交時呼叫 Maker 指定的合約

來源：`contracts/instructions/Extruction.sol`、`contracts/SwapVM.sol`。

- 成交時，SwapVM 把這筆交易的換入／換出代幣、策略目前的 Aqua 餘額（`balanceIn`、`balanceOut`）、換入／換出數量交給外部合約。
- 外部合約可以修改這些數字、跳到程式其他段落，或直接 revert 讓這筆成交失敗。
- 報價（quote，唯讀）與成交（swap）兩種模式都會呼叫，外部合約應該兩邊算出一樣的結果。
- 放在曲線指令之後，就拿得到曲線算好的換出數量，可以逐筆檢查上限或調整數量。
- 原始碼註解明確提醒：外部合約應該是確定性的，避免中心化與可升級；Maker 的最低價格與最大支出要另外設防。PROGRAMS.md 也說含 Extruction 的程式要特別仔細測試。
- 官方測試裡有一個 Extruction 範例：`test/solidity/mocks/BestRouteSelector.sol`，可以給 pengu 參考。

### 誰能來成交

來源：Aqua 官方文件 [Capability status](https://business.1inch.com/portal/documentation/aqua/overview/capability-status)、[Access, resolvers and Pathfinder](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/access-resolvers-and-pathfinder)。

- 官方寫：在部署版上，成交方的 tx.origin 必須持有 `KycNFT`，也就是經過 KYB 的 1inch Resolver。一般測試錢包不能成交。
- 原始碼裡這道門是策略程式中的一條指令（`OnlyTxOriginTokenBalanceNonZero`），不在路由器裡。但官方說部署版預設拒絕，實際能不能省略，要實測。
- 官方沒有說明 Pathfinder 會不會路由含 Extruction 的策略。
- 同一個錢包的多個策略共用真實餘額，先成交的先拿，不是各自保留。

### Chainlink 機密運算

來源：[Confidential Workflows](https://docs.chain.link/cre/concepts/confidential-workflows)、[Building consumer contracts](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)。

- 只有標記為機密的 callback 在 enclave 裡跑；觸發、讀鏈、寫鏈、產生簽名報告都在一般的 DON 節點上。**報告與送上鏈的內容不受保護**，要自己避免把私密資訊帶出來。
- 秘密由 Vault DON 在 enclave 內解密。文件只講 workflow 擁有者設定的 secrets，沒講多位使用者各自提交加密輸入的方法。
- 目前是 private beta，要跟 Chainlink 申請；本機可以先用模擬模式。
- 上鏈方式：我們的合約實作 `onReport(bytes metadata, bytes report)`，由 `KeystoneForwarder` 呼叫。官方的 `ReceiverTemplate` 可以限定只收某個 workflow ID 或擁有者的報告。模擬時用的是 `MockKeystoneForwarder`。

## 二、架構提案：PinTool Guard

把上面的事實接起來，得到一個 Aqua 原生工具就能做到的架構：

```text
Provider 私密邏輯 ─┐
                   ├─> Chainlink TEE ──報告──> PinTool Guard 合約 (onReport)
Maker 私密限制 ────┘   只輸出衍生參數           存每個策略目前的參數
                                                     ▲
                                                     │ 每筆成交時讀取
Maker 上架一次的 Aqua 策略：[曲線指令] → [Extruction(Guard, Maker 硬上限)]
```

每筆成交時，Guard 依序檢查：

1. **報告是否過期**：超過 Maker 設定的時效就拒絕成交。TEE 停擺時策略自動停止，而不是用舊參數繼續跑。
2. **方向是否允許**：TEE 可以關掉某個方向，例如停止收進某個幣。
3. **數量上限**：這筆換出、換出後的庫存，是否超過上限。以代幣數量計，不需要價格，結果確定。
4. （進階）**調整報價**：依 TEE 給的偏移量，把會增加庫存的那個方向的換出數量調少一點。

這個設計解決了三件事：

- **不用每次重簽**：Maker 上架一次，之後 TEE 在 Maker 允許的範圍內更新 Guard 參數。上一版交接規格寫的「第一版 Maker 親自啟用、不做自動調整」，這樣就能往前推一步，而且不用把錢交給任何人。
- **TEE 只能收緊，不能放寬**：Maker 的硬上限寫在 Extruction 的參數裡，跟著策略一起上架、不可更改。Guard 最多只能比它更嚴。TEE 或 Guard 出問題，損失也被硬上限框住。
- **逐筆生效**：限制在每一筆成交時由合約檢查，不是 TEE 定期看一看。

誠實的邊界：

- Guard 的參數與硬上限都在鏈上，是公開的。能保密的是 Provider 怎麼算出這些參數，以及 Maker 原始的偏好與門檻。所以 TEE 應該只輸出最少的衍生值，例如「方向開關、本期剩餘額度」，而不是把 Maker 的完整設定寫上鏈。
- Guard 是可更新狀態的合約，正是原始碼註解提醒要避免的類型。報價與成交之間若剛好有新報告上鏈，結果會不同。黑客松可以接受，但要寫進風險說明。
- 官方沒說 Pathfinder 會不會路由這種策略，所以 demo 應該用自己部署的環境。

## 三、候選策略重新評分

| | 穩定幣做市＋脫鉤防護 | 庫存感知做市 | 集中流動性＋Decay |
|---|---|---|---|
| 曲線 | PeggedSwap | XYC 或 XYCConcentrate | XYCConcentrate＋Decay |
| Provider 的私密價值 | 哪些訊號、什麼門檻判定脫鉤風險，越早越值錢 | 公允價格、方向判斷、調整速度 | 區間與 decay 參數怎麼選 |
| Maker 的私密限制 | 每個穩定幣最多願意持有多少、多早停手 | 目標庫存比例、容忍偏離 | 投入額度、可接受區間寬度 |
| TEE 算什麼 | 風險等級 → 要不要關掉「收進弱勢幣」的方向 | 目前庫存 vs 目標 → 方向開關、偏移量 | 新的區間與參數 |
| Guard 能逐筆強制 | 方向開關、持有上限、報告時效 | 方向開關、數量上限、報價偏移 | 幾乎沒有，區間寫在不可改的程式裡 |
| 參數要更新時 | 不用重簽 | 不用重簽 | 要 Maker 下架再上架 |
| Demo 事件 | 清楚：脫鉤訊號出現，某方向的成交開始失敗 | 要多筆成交才看得出庫存被拉回 | 要看區間移動，較抽象 |
| 資料 | 穩定幣價格可用 Chainlink Data Feeds | 需要公允價格來源 | 需要價格與波動 |
| 實作量 | 最低 | 中，偏移量要算對雙方向 | 高，而且自動化要重簽 |

## 四、建議

**MVP 模板：穩定幣做市＋脫鉤防護。** 理由：

- 事件清楚，評審一看就懂為什麼 Provider 的判斷值錢、Maker 的限制有作用。
- 每一條規則都能由 Guard 逐筆強制，不靠「TEE 有看」。
- 用到 Chainlink Data Feeds 與機密運算，跟賽道貼合。
- 實作量最低，pengu 可以先做固定參數的 PeggedSwap，再加 Guard。

**第二個模板：庫存感知做市。** 上一輪把它列為研究主線，這輪沒有推翻，只是它跟脫鉤防護用的是**同一個 Guard**，差別只在 TEE 算什麼、Guard 多一個報價偏移。所以先把 Guard 做穩，再加庫存感知，是順的路線，不是換題。

**集中流動性＋Decay 降為展示用範例。** 參數寫死在不可改的程式裡，TEE 能做的只有提議，自動化必須每次重簽，沒辦法展示「逐筆生效」。

### Demo 劇本草案

所有價格與訊號都是標明為合成資料的測試數據，不是真實市場。

1. 兩位 Maker 用同一個 Provider 策略，但持有上限不同，各自上架一次。
2. 正常狀態：測試成交方雙向都能成交。
3. 注入合成的脫鉤訊號：TEE 送出新報告，關掉「收進弱勢幣」的方向。上限較嚴的 Maker 先停。
4. 再試同方向成交：合約 revert，Maker 沒有多收弱勢幣；反方向照常成交。
5. 停止送報告：超過時效後，兩個策略都自動停止成交。

## 五、要跟隊友確認

**pengu（Aqua 執行端）**
- 自己在哪條測試網部署 Aqua 與 AquaSwapVMRouter？原始碼有 `script/DeployAquaSwapVMRouter.s.sol`。
- 官方部署版能不能省略 KycNFT 那條指令？若不行，demo 就全用自己的部署。
- Extruction 的報價與成交是否一致：用 `BestRouteSelector.sol` 當範例，做一個最小的 Guard 測試。

**ㄍㄨㄢ材（TEE）**
- Confidential Workflows 的 beta 權限怎麼拿？黑客松期間 Chainlink 有沒有開放？
- 模擬模式能不能把報告真的送到測試網上的合約，還是只能在本機？官方文件寫法看起來是只在本機，需要實測。
- Provider 與 Maker 各自的私密輸入怎麼進 enclave？文件只講 workflow 擁有者設定的 secrets，多人輸入需要自己設計，例如使用者用 enclave 的公鑰加密。

## 六、還沒做的

- 沒有找到帶交易紀錄的 Aqua Maker 真實績效，所以不報任何收益數字。
- 脫鉤訊號本身（哪些指標、多早能判斷）還沒研究，這是 Provider 範例邏輯的內容，下一輪可以做。
- Guard 的介面、報告格式、硬上限的編碼，還沒寫成規格。
