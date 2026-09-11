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

## 第一個模板提案

先採 WETH／USDC 單一價格區間 CLMM。Provider 根據市場快照選取候選區間與費率，Maker 限制投入額度與允許的參數範圍。

理由：1inch 官方提供 AquaAMM 與 MockTaker 範例，適合先驗證策略生成到成交的流程。先前討論的 signal-driven 短效雙邊報價是備選，並非已定案；先不讓執行端同時實作兩種模板。

MVP 不聲稱這套規則有超額收益；模板只證明雙方條件能被合成及執行。任何測試價格、額度、門檻都必須標示 synthetic fixture，與 live market data 分開。

## 雙方輸入與公開邊界

| 來源 | 私密輸入 | 對外顯示 |
|---|---|---|
| Provider | signal 判斷、候選區間、費率、可接受調整範圍、最低部署規模 | 作者、模板用途、策略版本與 commitment |
| Maker | token 使用上限、允許交易對、最低費率、允許區間寬度、資料時效要求 | 本人可看完整 policy；其他人只看必要 commitment |
| 市場來源 | 本身通常公開；包含來源、時間、價格及單位 | 資料來源與時間戳 |
| TEE 輸出 | 細部拒絕理由僅授權 Maker 可看 | 啟用所需參數、交易結果、版本與 report 關聯 |

輸入須以經驗證的 TEE 加密通道提交。若先送一般 backend 或外部 LLM，不能再宣稱 PinTool 看不到。TEE 同時持有兩方秘密，因此還需限制 evaluator 的輸出欄位與網路存取，不能允許任意 Provider 程式讀取後外傳 Maker policy。

## 合成規則

1. 驗證雙方版本、token pair、金額格式、市場快照時效與價格單位。
2. Provider evaluator 產生一個候選方案；Agent 若有參與，只可提議結構化候選方案。
3. Validator 檢查費率、區間與額度。只有 Provider 明確允許縮放時才能縮小配置；不能擅改策略假設。
4. 超過 Maker 額度則按比例縮放兩種 token，維持候選配置比例；若低於 Provider 最低部署規模則拒絕。
5. 兩種 token 與區間對應的初始價格必須一致。不能任意塞金額後假設 AMM 仍以外部市場價格報價。
6. 通過後生成綁定 Maker、版本、市場快照、期限及 deployment 的執行方案；拒絕結果不得帶可啟用 payload。

報價價差、oracle 偏離、庫存與損失限制不能混為一談。快照檢查僅證明產生方案當下符合條件；如要保證每筆成交的價格／庫存限制，需執行端逐筆 enforce。最大損失先列為研究欄位，不列入已保證的 MVP 條件。

## 交接介面 v0

這是應用層契約，並非 Chainlink 或 SwapVM 原生 API。

共同 envelope：`schemaVersion`、`requestId`、`makerAddress`、`chainId`、`providerVersion`、`providerCommitment`、`policyVersion`、`policyCommitment`、`marketSnapshotId`、`issuedAt`、`expiresAt`、`nonce`。

結果分兩種：

- `APPROVE`：包含 `templateId`、`baseToken`、`quoteToken`、`priceLower`、`priceUpper`、`feeBps`、`baseAmountAtomic`、`quoteAmountAtomic`。
- `REJECT`：包含對外安全的 `reasonCode`；詳細 policy 門檻不進公開 logs。沒有 execution payload。

單位約定：價格一律 quote/base，即 USDC per WETH，以十進位字串傳送；金額為 token 最小單位的整數字串；`feeBps` 中 10000 表示 100%；時間為 Unix seconds。這些是我們的介面單位，不可直接當成 SDK 單位。

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
4. 核准：顯示自己將採用的區間、fee、金額與期限，確認並啟用。
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

整合前要釘住：模板是否採單區間 CLMM、chain／官方合約版本、TEE 能力與 report 驗證途徑、Maker 親簽或授權 executor。第三 sponsor 暫不增加工程依賴。

## 技術依據

- [1inch SwapVM Template](https://github.com/1inch/swap-vm-template)：AquaAMM、MockTaker 與策略參數範例。
- [1inch SwapVM SDK](https://github.com/1inch/sdks/blob/master/typescript/swap-vm/README.md)：區間設定與 instruction 支援；SDK 能編碼不代表部署版本能執行。

來源只支持底層能力；雙方合成、隱私通道與驗證設計是本文件提出的產品方案，仍需實作驗證。
