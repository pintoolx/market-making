# PinTool Market Making product website

狀態：2026-09-12 產品資訊架構。這份文件定義網站本身；錄影只取其中一條已連通的使用路徑。

## 產品承諾

PinTool 讓做市策略作者發布可驗證但不公開完整邏輯的策略，讓 Maker 在保留資產控制權與私人風險限制的情況下使用。網站必須幫使用者完成三件事：判斷策略是否值得使用、授權一個有限的 mandate、持續知道資金與策略正在發生什麼。

在績效計算、fee settlement 或 confidential submission 尚未接通前，畫面不可宣稱已產生收益、已收取績效費、策略已由 TEE 保護或已在鏈上啟用。

## 核心物件

### Strategy

由 Provider 擁有。包含公開 listing、execution envelope、私密 activation policy、版本 commitment 與可驗證的發布狀態。

生命週期：`DRAFT → SUBMITTING → PUBLISHED → PAUSED → ARCHIVED`。只有 registry／commitment 成功後才可顯示 Published。

### Mandate

由 Maker 擁有。將一組可相容的 Strategy 與 Maker 私密限制綁在一份資金授權下。首次使用從一套 Strategy 開始，之後才加入更多策略。

生命週期：`DRAFT → AWAITING_SIGNATURE → EVALUATING → ACTIVE / REJECTED → EXPIRED / REVOKED`。Review draft 不得顯示為 waiting for execution。

### Execution

一筆由 Guard 判定並經 Aqua settlement 的活動。至少連結 mandate sequence、strategy hash、report digest、transaction receipt 與資產變化。UI 不自行推測 settled 或 rejected。

### Provider

公開身份、已發布策略與可驗證紀錄。追蹤人數、報酬率、volume 或 AUM 只有在資料來源接通後才顯示。

## 全站資訊架構

主導覽應以日常任務命名：

- **Strategies**：公開 Marketplace，任何人可瀏覽。
- **Portfolio**：Maker 的 mandates、資產、active strategy 與 activity。
- **Studio**：Provider 的 drafts、published strategies、versions 與收入。
- **Account**：身份、wallet 與 profile。

首頁負責一句產品價值、主要 CTA 與信任模型。角色說明可以存在，但不應要求回訪者每次先選角色。

## Maker journey

1. 在 Strategies 依 pair、mechanism、risk、status 篩選。
2. Strategy card 只顯示做決策所需摘要：名稱、Provider、pair、mechanism、fee 與 availability。不要在每張卡重複解釋 TEE。
3. Detail 顯示 public envelope、適用情境、主要風險、Provider、版本、可驗證狀態與 fee。私密模型只標示為 proprietary，不假裝揭露內容。
4. `Use strategy` 後才要求登入與 wallet。
5. Maker 設 capital、inventory、per-fill、asset 與 expiry boundaries；系統解釋每個欄位會限制什麼。
6. Review 分開顯示「你允許什麼」與「Provider 要求什麼是私密的」。
7. 簽署／評估成功後進 Portfolio。重新整理頁面仍能由 durable mandate ID 恢復。
8. Portfolio 才提供 Add strategy、revoke、renew 與 execution history。

## Provider journey

1. Studio 首頁先顯示 drafts、published、paused 與需要處理的版本，不直接跳模板牆。
2. New strategy 先選 base execution mechanism；modifier 與 capital policy 是下一步可加入的模組，不與 base strategy 混成同一層商品。
3. 依 mechanism 填可驗證的 execution parameters。
4. 用結構化 condition 填 signal、operator、threshold、window、recovery 與 data source。自由文字只作為說明，不能直接控制資金。
5. Preview 同時檢查 public listing、public envelope、private-field 清單與 Provider fee。
6. Confidential submission 成功並取得 commitment 後才顯示 Published。
7. 已發布頁顯示版本、使用中的 mandates、activity 與可驗證收入；沒有資料時顯示 unavailable，不製造數字。

## 當前前端必修

1. `publishedStore` 仍只可視為 listing cache；`proposalStore` 只在 mandate service 確認建立成功後寫入本機索引，不得自行推測鏈上狀態。
2. Profile 的 Providing／Making 改成 Studio／Portfolio，並依真實狀態分組。
3. Header 改為 Strategies／Portfolio／Studio，讓回訪路徑穩定。
4. Marketplace seed listings 只能呈現有對應 fixture／strategy definition 的項目；其餘模板留在 Studio。
5. Detail 補 pair、mechanism、fee、risk、version 與 verification status。沒有績效資料就不顯示績效。
6. Mandate monitor 必須能用 URL 或 account 恢復，不可只存在 React component state。
7. 移除尚未實作的「只在獲利時付費」承諾，直到 accounting 與 settlement 有明確介面。

## ETHOnline 展示切片

錄影使用一個已有兩套相容 strategy 的 mandate，展示 Provider commitment、Maker boundaries、CRE report 更新、active strategy 反轉、Guard enforcement 與 Aqua receipts。這些證據由真實產品物件產生；網站不提供人工製造成功／失敗狀態的按鈕。
