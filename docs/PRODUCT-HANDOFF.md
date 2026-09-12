# ETHOnline：雙方私密規則合成做市策略

狀態：2026-09-11 工作草案。已決定 Chainlink + 1inch Aqua；本文件提出第一個模板與交接介面，尚未代表團隊確認實作可行或完成整合。品牌、From Scratch／Continuity 身分尚待依實際沿用成果判定。

## 名稱與 repo 邊界

- GitHub repo：`pintoolx/market-making`
- 網站產品名：**PinTool Market Making**
- ETHGlobal 提交名稱：**PinTool: Confidential Market Making**

Aqua 是本次第一個 execution adapter，不是產品名稱。未來接入其他做市協議時仍留在 Market Making 產品內，不按協議另開 repo。本 repo 採 monorepo，容納前端、TEE runtime、合約、共用 schema 與 execution adapters。

## 產品與成功標準

Strategy Provider 提供私密做市邏輯，Maker 提供私密資金與風險限制。TEE 內的策略 evaluator 產生候選方案，再由確定性的 policy validator 檢查。符合條件才輸出 Aqua／SwapVM 執行方案；不符合則拒絕。

價值是讓雙方合作而不直接交換完整規則。TEE 外的成交參數、數量、時機仍可能公開並洩漏部分資訊；不能宣稱永久隱藏完整策略或保證不虧損。

成功標準：同一份 Provider 策略，在不同 Maker policy 下產生不同額度，或明確拒絕；通過的方案有真實 Aqua swap，拒絕的方案沒有新策略啟用。

## ETHOnline 主線

2026-09-12 的題目盡職調查找到數個高度重疊的既有作品：Aqua Prime 已做同一本 inventory 上的 strategy race，Sluice 已做 TEE 內生成 Aqua strategy，Doca 已做 shared-balance inventory guard。因此單一動態 MM 或 Toxic-Flow Shield 不足以當整個作品的創新。

目前主線改為 **Confidential Strategy Mandate**：Provider 的私密決策政策與 Maker 的私密資金限制在 Chainlink TEE 內取交集，只輸出一張短效、可撤銷、可逐筆 enforce 的 Aqua strategy mandate。完整結論、競品與 go／no-go 見 [TOPIC-DILIGENCE.md](TOPIC-DILIGENCE.md)。

## 第一個策略 fixture

Defensive Strategy B 採 **Confidential Toxic-Flow Shield**，以 adverse-flow 風險作為可理解的 high-vol regime。Provider 私下定義風險判斷；Maker 私下定義 inventory、單筆成交、資金與報告時效上限。TEE 只輸出可逐筆執行的方向、額度與 active strategy hash，PinTool Guard 經由 SwapVM Extruction 在每筆 Aqua swap 強制執行。

錄影只做兩套固定執行 envelope：正常狀態允許 Strategy A、阻擋 B；高波動狀態阻擋 A、允許 Defensive Strategy B。兩套策略使用同一個 Maker wallet。Toxic-Flow Shield 的方向測試仍以 [WINNING-FLOW.md](WINNING-FLOW.md) 為 fixture 參考。

MVP 不宣稱這套規則有超額收益或能預測脫鉤；它證明雙方秘密可以被合成為自託管且可驗證的執行邊界。任何測試價格、額度、門檻都必須說明資料來源，不能把 synthetic fixture 說成 live market data。

## 雙方輸入與公開邊界

| 來源 | 私密輸入 | 對外顯示 |
|---|---|---|
| Provider | 脫鉤訊號、判斷門檻、方向切換與恢復規則 | 作者、模板用途、策略版本與 commitment |
| Maker | 資金上限、USDT inventory、單筆成交與資料時效限制 | 本人可看完整 policy；其他人只看必要 commitment |
| 市場來源 | 本身通常公開；包含來源、時間、價格及單位 | 資料來源與時間戳 |
| TEE 輸出 | 細部拒絕理由僅授權 Maker 可看 | 啟用所需參數、交易結果、版本與 report 關聯 |

輸入須以經驗證的 TEE 加密通道提交。若先送一般 backend 或外部 LLM，不能再宣稱 PinTool 看不到。TEE 同時持有兩方秘密，因此還需限制 evaluator 的輸出欄位與網路存取，不能允許任意 Provider 程式讀取後外傳 Maker policy。

## 合成規則

1. 驗證雙方版本、token pair、金額格式、市場快照時效與價格單位。
2. Provider evaluator 依私密邏輯產生結構化風險候選；Agent 若有參與，不可直接控制資金。
3. 確定性 Validator 檢查候選結果、Maker 硬上限、方向語意、版本與時效。
4. TEE 只能縮小額度或關閉方向，不能放寬 Maker 隨策略上架的硬限制。
5. 方向一律使用 Maker 視角：`Maker receives USDT` 會增加 USDT inventory；`Maker pays USDT` 會減少 USDT inventory。
6. 通過後生成綁定 Maker、strategy hash、sequence、市場快照與期限的 Guard report；拒絕結果不得帶可執行 payload。
7. Quote 與 swap 都要帶同一個 `expectedSequence`；report 在兩者之間更新時，swap 應以 stale mandate 明確 revert。

報價價差、oracle 偏離、庫存與損失限制不能混為一談。快照檢查僅證明產生方案當下符合條件；如要保證每筆成交的價格／庫存限制，需執行端逐筆 enforce。最大損失先列為研究欄位，不列入已保證的 MVP 條件。

## 交接介面 v0

這是應用層契約，並非 Chainlink 或 SwapVM 原生 API。

共同 envelope：`schemaVersion`、`requestId`、`makerAddress`、`chainId`、`providerVersion`、`providerCommitment`、`policyVersion`、`policyCommitment`、`marketSnapshotId`、`issuedAt`、`expiresAt`、`nonce`。

結果分兩種：

- `APPROVE`：包含兩個 Maker 方向的允許狀態、單筆上限、剩餘 inventory capacity、sequence、期限與 decision digest。
- `REJECT`：包含對外安全的 `reasonCode`；詳細 policy 門檻不進公開 logs。沒有 Guard update payload。

完整 v1 欄位以 [WINNING-FLOW.md](WINNING-FLOW.md) 為準。所有整數以十進位字串傳送，金額使用 token 最小單位，時間為 Unix seconds；不可用 JS `number` 承載 atomic amount。

pengu 的 adapter 負責 token 地址排序、decimals、價格倒數與 sqrtPrice scaling，以及 fee 單位轉換。必須固定 SDK／合約版本，確認實際部署支援哪些 instructions。

最終 report 必須綁定實際執行內容：若 bytecode 在 TEE 外編譯，執行端必須可驗證它與核准參數完全對應，例如固定且可驗證的 compiler／template，或回 TEE 綁定最終 program hash。只有任意內容的 hash，不能證明 policy 被遵守。

## 執行權限與狀態

第一版由 Maker 在核准結果後親自啟用；這能示範策略生成及真實成交，但不宣稱全自動調倉。若要授權 executor 自動 ship／dock，需另行完成 Maker wallet 授權及 report 驗證，不能把一般 EOA token approval 當成策略管理授權。

狀態：`INPUT_READY → EVALUATING → APPROVED / REJECTED → AWAITING_MAKER → ACTIVE → DOCKED / EXPIRED`。

拒絕新方案不會自動停用舊方案。若已存在 ACTIVE 策略，畫面須明示舊策略仍啟用；停用應是獨立且有權限的動作。新版替換需防止兩版本重疊用額度；優先原子替換，做不到則先確認 dock 成功，再 ship。

## 產品流程

1. Provider：選模板、填私密規則、提交；看到版本與已接收狀態。
2. Maker：選 Provider、填額度與限制；只看自己的 policy。
3. 評估：顯示資料時間、處理狀態；不顯示另一方原始條件。
4. 核准：顯示兩個 Maker 方向、單筆上限、剩餘 inventory capacity 與期限，確認並啟用。
5. 拒絕：顯示「目前條件無法形成可執行策略」，Maker 可查看授權的詳細原因。
6. 成交：顯示 token 餘額變化、策略識別與 swap 交易；測試 taker 明確標示為測試。

Provider 的 Condition／Action 留在策略邏輯；Maker 的部位與資金分配由輸出推導，呈現在 Position／Split 層。這份先定流程，尚未修改既有 UI。

## Demo 與驗收

| 案例 | 預期結果 | 證據 |
|---|---|---|
| 相容 | APPROVE，Maker 啟用並成交 | report 關聯、program／strategy hash、ship 與 swap tx、前後 token balances |
| 額度縮小且 Provider 允許 | 兩 token 同比例縮小 | Maker 私有檢查結果、公開執行額度 |
| 最低規模／費率與 policy 衝突 | REJECT，沒有新 ship | 無 payload、無新鏈上策略 |
| 市場快照過期 | REJECT | 時間戳與安全 reason code |
| payload 被改／過期／重播 | 執行端拒絕 | 合約或授權流程失敗證據 |

先完成相容與衝突兩案，其他是執行驗證必查項。畫面收到 JSON 不代表 TEE 成功，模擬 TEE 不可標成真實 confidential execution，成功 swap 也不代表策略獲利。

## 分工與下一個交付

- Canfly：本產品規格、模板邏輯、合成規則、成功／拒絕 fixtures、demo 文案與流程。優先確認模板與介面，再做視覺。
- ㄍㄨㄢ材：實際機密輸入路徑、TEE evaluator／validator、秘密與 logs 邊界、可驗證輸出。先接共同介面，確認 Agent 是否真的能在預定環境中執行。
- pengu：固定參數的 Aqua 成交、compile adapter、Maker 授權與策略啟停、部署版本及 token 單位。先回報可支援的 template 欄位及官方 deployment。

整合前要釘住：Maker／Taker 方向對應、chain／官方合約版本、TEE report 編碼與驗證途徑、Maker 親簽或授權 executor。第三 sponsor 暫不增加工程依賴。

## 技術依據

- [1inch SwapVM Template](https://github.com/1inch/swap-vm-template)：AquaAMM、MockTaker 與策略參數範例。
- [1inch SwapVM SDK](https://github.com/1inch/sdks/blob/master/typescript/swap-vm/README.md)：區間設定與 instruction 支援；SDK 能編碼不代表部署版本能執行。

來源只支持底層能力；雙方合成、隱私通道與驗證設計是本文件提出的產品方案，仍需實作驗證。
