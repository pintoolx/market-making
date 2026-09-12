# 前端 LP 功能補完交接

整理日期：2026-09-12。主 repo：`pintoolx/market-making`。

**最新整合進度：** 已新增 [CLMM 版本發布與 readiness](LP-RELEASES.md)：簽名不可覆寫版本、公開 envelope／加密 policy 分離、不對稱區間編譯、核准版本與 ciphertext 綁定、固定區塊的 Guard／Aqua／資金檢查。舊的僅 localStorage 發布入口已替換。下文原始缺項保留作為產品清單；自動 Maker ship、其他模板、私密參數跨裝置還原與真實 TEE 仍未完成，不應將這一階段當成六張卡全部驗收通過。

使用者目標：讓目前前端列出的 6 種 Aqua 策略模板，都能從設定、發布、Maker 選用一路走到實際執行與可驗證的結果。

這份文件由 side conversation 根據唯讀程式檢查整理。它是後續實作的需求與驗收清單，**不代表下列缺項已完成**。本次只新增這份文件，沒有修改程式、部署、廣播交易或操作 Git。Main session 接手時應先核對最新工作區與使用者授權，保留正在進行的修改；文件本身不擴張部署或上傳的授權。

## 1. 現況結論

執行器目前的 `StrategyProgram` 只有三種曲線：`xyc`、`concentrated`、`pegged`。三者都有編譯路徑，並非只有型別宣告。

| 前端模板 | 現有能力 | 尚不能算完成的部分 |
| --- | --- | --- |
| Classic two-sided / XYC | 恆定乘積曲線、一般策略費用、Guard V1、完整 executor lifecycle | 前端發布到執行未打通；前端預設 30 bps 與 guarded 策略零費用限制衝突 |
| Adaptive range / CLMM | 單區間集中流動性、區間換算、Guard V2 真實庫存檢查、到期後 autopilot 換區間／續期 | 前端區間與訊號尚未串接；完整換區間加新 report 流程未驗證；不會主動換幣恢復庫存 |
| Stable-asset maker / PeggedSwap | 參考餘額與 rates 正規化、曲線參數、一般策略費用、Guard V1 | 前端 reference / spread 尚無完整映射；價格更新、脫鉤反應與交易對選擇待補 |
| Decay maker | 前端卡片與表單 | 執行器尚未接入 decay；表單固定 bps 調整也不是原生指令的直接參數 |
| Inventory-aware maker | 已有庫存上限、方向限制、最大損失監控 | 尚無目標比例、容忍區間、報價調整與恢復控制器 |
| Shared capital | Aqua 虛擬餘額；Guard V2 與 mandate API 採每 Maker 最多一個 active strategy | 尚無完整配置／優先序控制器；多策略同時成交需要新的授權與整體資金管理設計 |

XYC 與 concentrated 有 Ethereum Sepolia 公開交易證據。Concentrated demo 包含雙向成功成交與刻意被 Guard 擋下的交易；使用的是 synthetic report，不能算真正 CRE／TEE delivery。Pegged 有本地真實 Router 測試，尚未找到對應公開鏈驗證紀錄。本次未重跑測試，結論來自原始碼、測試內容與既有證據文件。

主要依據：

- [策略型別](../contracts/aqua-executor/src/types.ts)
- [曲線編譯](../contracts/aqua-executor/src/curves.ts)
- [一般編譯器](../contracts/aqua-executor/src/compile.ts)
- [Guard 編譯器](../contracts/aqua-executor/src/guard.ts)
- [LP 實作說明](../contracts/aqua-executor/docs/LP-STRATEGIES.md)
- [Sepolia demo 證據](../contracts/aqua-executor/docs/ethereum-sepolia-demo.md)

`LP-STRATEGIES.md` 和 `docs/ARCHITECTURE.md` 在檢查時仍有「未部署 Guard V2／receiver 尚不支援切換」的舊敘述。部署狀態應核對最新 [deployment bundle](../contracts/aqua-executor/deployments/11155111.json) 與 [receiver revision 文件](../contracts/aqua-executor/docs/ETHEREUM-SEPOLIA.md)，不要以舊敘述覆蓋新證據，也不要把歷史 demo 當成後續合約 revision 的測試。

## 2. 必須先修的共同串接缺口

### 2.1 Provider 發布目前只保存 listing

`ProviderFlow.tsx` 的 `publishNow()` 只把模板、名稱、介紹、Provider 資訊及 feePct 傳給 `publish()`。`publishedStore.ts` 將這些欄位寫入瀏覽器 localStorage。

策略的 `parameters`、`rules`、signal、threshold、lookback、recoveryThreshold 沒有隨發布送到執行端，發布後 draft 還會被刪除。因此目前顯示「Your strategy is live」不能作為策略可執行的證據。編輯已發布 listing 時也會重建預設參數，無法還原原始策略。

另外，私密草稿目前會寫入 sessionStorage；正式保密設計需要明確處理草稿保存、清除與使用者端資料保護，不能宣稱私密輸入從未保存。

需要補：

- 真正的 Provider 發布／更新／撤下介面，以及穩定的策略 ID 與版本。
- 公開 listing 與私密 policy 分開保存；公開資料不能包含私密門檻。
- 私密參數透過已驗證的 confidential input 路徑交給執行端。
- 版本化且可驗證的結構化 policy schema；自然語言 `rules` 不能直接當作可執行策略。若保留自由文字，需明確標記其用途，或提供生成後可檢查的結構化結果。
- 發布完成後能重新讀取同一版策略；更改參數會形成新版本，執行紀錄能回溯當時版本。
- 發布失敗保留草稿，不得顯示成功；不能把私密參數直接加進公開 localStorage 來修復資料遺失。

依據：[ProviderFlow](../frontend/src/app/marketplace/ProviderFlow.tsx)、[publishedStore](../frontend/src/app/marketplace/publishedStore.ts)。

### 2.2 Maker 選用尚未形成完整自動執行流程

目前 direct CRE runner 使用預先配置的 listing → strategyHash catalog；Maker policy 必須匹配預先配置的 digest。這是現有的明確限制，不是任意前端參數都能進入 TEE。

完整路徑需要接通：

```text
Provider 發布版本化策略
  → Maker 選策略、設定限制
  → 驗證交易對、錢包資產與可用 allowance
  → 產生執行方案並取得所需錢包簽名
  → 編譯 Aqua program、ship
  → 依實際市場資料計算授權、送到 Guard
  → 確認 Guard 接受與策略可成交
  → 成交、持續評估、必要時換策略或 dock
  → 前端呈現鏈上確認的狀態與結果
```

Report 與 ship 的實際先後由狀態機安排；只有兩者條件都滿足，才能呈現為可成交。不得把「已授權但尚未 ship」或「已 ship 但沒有有效 report」顯示為完全就緒。

需要持久化各階段、處理重試／中斷／交易失敗，沿用既有 executor journal。換 range、salt、caps 或 program 形成新 strategyHash 時，必須取得綁定新 hash 的 report。

依據：[mandate API](STRATEGY-MANDATE-API.md)、[orchestrator README](../orchestrator/README.md)、[direct runner](../orchestrator/src/cre-mandate-runner.mjs)。

### 2.3 表單訊號要有可執行定義

目前 Provider UI 列出 realized volatility、price deviation、inventory ratio、net order flow，另有 operator、threshold、lookbackMinutes、recoveryThreshold。

每項必須定義：來源、單位、採樣頻率、時間窗、時效檢查、觸發與恢復條件。百分比和 bps 不可混用；Maker 買賣方向與 taker 方向不可顛倒。

- 波動率：固定公式與窗口，門檻必須針對同一公式校準。
- 價格偏離：明確指定相對哪個參考價，以及絕對值或正負偏離。
- 庫存比例：明確區分 Maker 錢包、某一 Aqua strategy 的庫存與多策略整體部位。
- 淨成交流：明確指定觀察哪些成交、以 Maker 或 taker 為方向、採哪些已確認區塊，避免漏算／重複計算。
- 資料不足、過期與讀取失敗有明確停用／恢復行為，不得填入假時間戳或假數值。

Main session 正在做市場觀測與授權 adapter；接手時應直接整合最新成果，避免重做或覆蓋。觀測資料格式完整，不代表已有真正 DON／TEE 執行證據。

## 3. 六種模板的補完內容

### 3.1 XYC

- 將 `baseFeeBps`、`maxFillUsdc`、`directions` 轉成實際編譯參數及授權限制。
- 解決 guarded 策略目前要求零費用的限制。要釐清成交 gross/net input、費用去向與真實庫存變化；不能只刪除 compiler 的零費用檢查。
- 方向及額度必須同時受 Provider 與 Maker 限制，換版本不能擴張 Maker 已接受的邊界。

驗收：前端設定 30 bps 後，鏈上成交確實使用 30 bps；單向模式阻擋另一方向；扣費後仍不能突破單筆與庫存限制。

### 3.2 Adaptive range / CLMM

- 將 `rangeBelowPct`／`rangeAbovePct` 與參考價格映射成 canonical concentration bounds；保留上下不對稱的設定語意。
- 接通價格／波動訊號、冷卻期、有效期、再置中規則，以及替換後的 report delivery。
- 現有 autopilot 等舊 program 到期後才替換。若產品要在未到期時換區間，需另處理觀測後仍可能成交造成的庫存變動，不能直接移除等待條件。
- 一邊庫存歸零時提供清楚的暫停／處理狀態；現有 compiler 與 autopilot 需要兩邊正數。
- 換區間不保證曲線 spot 等於外部參考價格，需做 quote/preflight，維持 Maker 的成交限制。

驗收：改上下百分比能改變實際曲線；符合條件時完成原子替換與新授權；舊 hash 不再成交；中斷重試不重複送交易；保留原 HODL 基準。

本項不要求 Uniswap V3 多 tick 池或 NFT position，因為目前卡片承諾是單一價格區間的 Aqua 策略。

### 3.3 Stable-asset maker / PeggedSwap

- 明確定義前端 `reference` 與 `spreadBps` 如何影響 `referenceBalances`、`rates`、`linearWidth` 或額外定價機制。
- 原生曲線參數不是一個可直接等同於固定 bid/ask spread 的欄位；以實際 quote 驗證映射，不能只改欄位名稱。
- 處理參考價格更新、過期、偏離／脫鉤停用與恢復。參考餘額不能在每次成交後隨意改成目前庫存。
- 支援合適的錨定資產交易對與其價格來源。前端／mandate 的 WETH/USDC 固定假設需檢查；不能把所有資產都假設等於 1 美元，也不能把未核實的 token 當成可用測試幣。

驗收：精度不同的代幣能正確報價；reference / spread 設定有可量測效果；參考過期或脫鉤時不能繼續獲得有效成交授權；完成公開測試鏈案例。

### 3.4 Decay maker

- 將 Decay 作為基礎曲線的 modifier，先指定可用組合，例如先支援 XYC + Decay，再逐一驗證其他組合。
- 加入 recipe、bytecode、持久化與 Guard 支援。Decay 會修改 VM 的定價餘額，風控仍需檢查真實可結算庫存。
- 表單的 `decaySeconds` 可對應原生 period；但 `adjustmentBps` **不能直接映射到原生 Decay**。

固定版本的 `DecayArgsBuilder.build()` 只接受 `uint16 decayPeriod`；offset 由成交量與前次狀態形成，再隨時間衰減。如果產品保留「固定調整 20 bps」，需要另行設計與測試。若採原生語意，必須同步修改表單與說明，不能默默忽略輸入。

驗收：成交前、成交後、衰減中、衰減結束的 quote 符合定義；雙向成交與連續成交正確累積狀態；quote 不修改狀態；期間內狀態改變時，swap 的 min-out 與 Guard 仍生效。

來源：[固定版本 Decay.sol](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/Decay.sol)。

### 3.5 Inventory-aware maker

- 加入 `targetWethPct`、`tolerancePct` 與目標資產的一般化表示，避免只有 WETH 可以使用。
- 用已確認庫存與有效價格計算比例，再根據偏離程度控制買賣方向、額度或報價。
- 必須明確選擇基礎曲線與報價調整方式；Guard 本身只負責允許／拒絕，不會自動讓報價更吸引人。
- 加入恢復區間、冷卻與遲滯，避免邊界附近頻繁切換。
- 保留 Maker 的硬上限及最大損失監控優先權。

建議第一版採被動庫存調整：持有 WETH 過多時減少繼續買入、優先促成賣出，回到容忍區間後恢復雙向。這符合現有「透過報價朝目標調整」的卡片承諾，不保證一定回到 50%。主動到其他 DEX 換幣是另一項能力，不應默認納入。

驗收：高於／低於目標與恢復區間時，有可觀察且方向正確的報價／授權改變；成交後重新評估；無成交時不虛構已回到目標；任何調整不得突破 Maker 邊界。

### 3.6 Shared capital

先確認產品的完成範圍，這會影響合約設計：

| 模式 | 所需工作 |
| --- | --- |
| 多策略待命、同時只有一個 active | 沿用目前 Guard V2 不變量；補策略選擇、配置優先序、預算與低餘額停用，以及切換後的狀態與 report |
| 多策略同時報價與成交 | 重新設計 active 集合、report 的授權範圍、Maker 整體風控與配置控制器；現有 Guard 與 mandate API 的單一 active 假設都要修改 |

不論哪種模式，都要實作 `strategyBudgetUsdc`、`priority`、`suspendBelowUsdc` 的明確語意；`balanced`／`volume`／`defensive` 必須對應可驗證的選擇規則。

Aqua 的虛擬配置不會鎖住錢包資產，不能將多個 strategy 的虛擬餘額相加當成 Maker 真正資產。要處理一個策略成交、外部轉帳或 allowance 改變後，其餘策略的可用資金與風險邊界。方案應明確區分每策略額度與整個 Maker 的限制。

驗收：資金不足依規則停用／縮減配置；切換不留舊授權漏洞；若支援同時成交，需有交錯成交的測試，證明各策略分別合規時仍不會繞過 Maker 整體限制。

不能用「輪替執行已完成」宣稱「多策略同時成交已完成」。同時成交不是原有單一 active 保證的自然延伸。

依據：[AquaGuardV2](../contracts/aqua-executor/contracts/AquaGuardV2.sol)、[mandate API](STRATEGY-MANDATE-API.md)、[Aqua 官方資金模型](https://github.com/1inch/aqua)。

## 4. 前端另有收益分成承諾

Provider 表單的 `feePct` 是「Maker 獲利的一定比例」，與 swap 的 `feeBps` 不同。目前 listing 保存了比例，但本次未找到對應的收益分成結算流程。

若目標涵蓋前端全部承諾，還需補：

- 利潤的明確基準、估值來源與結算期間。
- 區分交易收益、價格上漲、入金、出金與費用，避免把入金當成獲利。
- 防止同一段收益重複計費；明確定義虧損後恢復的計費方式。
- 分成支付方式、收款方、Maker 授權與可驗證的收費紀錄。

完成前應明確標示未啟用收費，不得因 listing 有 10% 就宣稱已自動分潤。

## 5. 建議實作順序

1. **共用 schema、發布與狀態機**：先讓一個真實 Provider 策略版本完整進入 Maker 執行流程。建立能力清單，UI 僅接受後端可執行的參數及組合。
2. **既有三種曲線完整串接**：XYC／CLMM／Pegged 的表單映射、交易對、費用與 Guard 一起完成。已有本地功能直接重用，不要重寫 lifecycle／journal。
3. **Inventory-aware**：先做被動方向／報價控制，加上明確恢復行為。
4. **Decay**：先解決固定 bps 與原生 period 的語意，從一種曲線組合完成到鏈上驗收。
5. **Shared capital**：先依使用者選定的模式實作，不把單一 active 與多 active 混為一談。
6. **收益分成與整體驗收**：完成費用承諾，再重跑所有模板的前端到 Sepolia 流程。

每階段都應交付可操作的完整流程，不以新增 UI 卡片、型別或 mock response 當作完成。政策資料路徑、行情輸入與 report delivery 是共用依賴，宜先打通。

建議資料模型分成「基礎曲線」「modifier」「資金政策」三層，避免把六張卡全部硬塞成六個互斥 `program.kind`。提供明確相容矩陣；不需要預設承諾所有 modifier 能任意組合。

## 6. 完成標準

- [ ] 六種模板的每個可填欄位都有後端定義、驗證與可觀察效果；不靜默忽略參數。
- [ ] Provider 策略真正保存並版本化，重新開啟能還原，公開 listing 不洩漏私密 policy。
- [ ] Maker 透過前端選用後，能得到對應程式、有效 ship、有效 Guard report 與真實交易證據。
- [ ] 授權不會超出 Maker 已確認限制；Guard 費用與虛擬定價餘額的處理有專門測試。
- [ ] 成功成交、方向拒絕、額度拒絕、資料過期、report 過期及撤回都有測試。
- [ ] 策略替換後舊 hash 無法繼續使用；新 hash 沒有 report 時維持不可成交。
- [ ] 重試／重啟不重複送出資產操作，並保留原始 HODL 基準。
- [ ] Shared capital 的同時 active 數與 UI、API、Guard 保證一致。
- [ ] Provider 分潤能正確結算。階段性交付期間可清楚標示尚未啟用，但不能因此宣稱全部前端承諾已完成。
- [ ] 前端顯示的成功／失敗與鏈上 receipt 一致；拒絕模擬不能冒充鏈上 reverted transaction。
- [ ] 每種已宣稱可用的模板，都有對應測試鏈驗收紀錄；新增交易仍依 main session 的現有授權執行。
- [ ] 分別記錄「本地程式／Router 測試」「CRE CLI simulation」「simulation broadcast 到鏈上」「真正 DON／TEE delivery」，不互相替代。

## 7. 版本與接手注意

- 執行器固定 `swap-vm` commit `32c687c2b73101fc26549e48fa1ff8a4d73afbac`（v1.0.2）與 SDK 0.4.4。上游 main 的 opcode 表不同，新增指令需對照實際部署 Router，再以真實 Router 測試。
- 不必為了完成六張卡先加入 limit order、Dutch auction、NFT position 或任意自訂 opcode；它們不是此次前端範圍。
- 相鄰的 `cre-hello-world/` 是 main session 正在做的 CRE 觀測工作；主 repo 的 `workflow/src/market-math.ts`、`market-observation.ts` 及相關測試在本次整理時已有進行中的未提交檔案，請保留並核對最新狀態。
- 使用者希望分階段補完。這份文件沒有替使用者決定 Decay 的固定 bps 語意、Shared capital 的同時執行模式或收益分成公式；實作前提出具體方案，只釐清真正影響設計的歧義。
- CRE 帳號登入與本地模擬不代表已取得真正 DON／Confidential Workflows 執行能力。資格與交付狀態以接手時實測為準，不能繼續引用早期「完全沒有 CRE 帳號」的舊結論。


## 8. Main session 接手核對與共用依賴進度（2026-09-12）

已核對本文件與固定版本原始碼；上述六種模板缺項仍是待完成的產品範圍。本輪先完成共用的市場／授權／Guard 路徑，不將此結果當成六張卡全部可用。

- 主 repo 的 `workflow/src/market-data/` 現在提供 Kraken ETH/USDC bid/ask 時間戳、固定 30 分鐘波動率及 Sepolia finalized Maker 錢包餘額；正式 confidential handler 已接入。`marketSource=kraken` 會自行取資料，拒絕 HTTP 注入的 `marketSnapshot`；fixture 只允許 dry-run。波動率定義是 `rss-simple-returns-30m-v1`，UI 其他 lookback／公式不能直接混用。
- 已補 Maker 身分綁定：HTTP maker 必須等於該 workflow 所配置私密限制的 maker，不能拿同一份 Maker policy 替任意地址發授權。
- Publisher 已與既有 delivery adapter 共用 receiver profile、receipt 與 digest 讀回驗證。完成 [CRE CLI broadcast → 現有 Guard V2 → CLMM 成交／實際拒絕](../workflow/verification/live-market-guard/README.md)。使用公開合成 policy；沒有 DON workflow 部署或真實 TEE attestation。
- 本輪碰到並恢復一次 ship 後的風控資料時效失敗：保留原請求、策略 hash、三筆交易 hash 和 HODL 基準；改取有原始時間戳的 ETH/USD、USDC/USD 報價。沒有把 USDC 固定視為 1 USD，也沒有放寬既定時效。
- 前端發布／版本保存、任意 Maker 的 confidential input provision、direct runner 的 live payload、ship＋report 聯合就緒狀態仍未接完。現有 direct runner 會送固定 snapshot，不能直接切 live mode；它需要同步改成只送已綁定的公開身份，並以確認的執行狀態回覆前端。

下一個產品階段依第 5 節順序，先做版本化 Provider schema、公開 listing／私密 policy 分離、能力清單與持久化狀態機，從 XYC 或 CLMM 的一條完整前端路徑驗收。30 bps Guard 費用、非對稱 CLMM bounds、Pegged 定價映射仍需各自測試，不能以本輪零費率 CLMM demo 代替。

設計建議保留供下一階段討論：資料模型分「基礎曲線／modifier／資金政策」；Inventory 第一版採被動方向調整；Decay 優先採原生 period 語意（固定版本 build 只收 uint16 period，沒有固定 bps 參數）；Shared capital 優先延續一個 active、多個 standby。最後兩項不視為使用者已定案，實作相關階段時再確認具體產品語意。
