# Aqua Maker 策略研究

日期：2026-09-11。研究官方文件、程式模式、做市文獻與參賽案例；未進行主網交易、績效回測或實測 TEE。先前交接稿的單區間 CLMM 是提案，不是已選定的策略。

## 證據與重要修正

1. Aqua 有策略 discovery／analytics 與 Pathfinder 路由，不能說必須自己從零建立全部市場基礎設施。官方 launch 路徑有 taker credential gate；自訂策略是否能路由、測試 taker 能否成交要依版本與 program 確認。[Access / routing](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/access-resolvers-and-pathfinder)
2. 官方 capability 表列出的執行族包含 XYC、Concentrate、PeggedSwap、Fee、Decay、Controls、Extruction。完整 SwapVM catalog 的 limit／auction 等模式不等於全部能直接在部署的 Aqua router 使用。[Capability status](https://business.1inch.com/portal/documentation/aqua/overview/capability-status)
3. 官方已描述 maker 的 monitor → build → sign → broadcast → confirm loop。單純 Agent 調區間本身不是新的協議能力。[Automation](https://business.1inch.com/portal/documentation/aqua/getting-started/automate-and-agentic-liquidity)
4. 本次找到的是可實作機制與原型，尚未找到經獨立驗證、可重現的 Aqua Maker 長期 alpha。官方收益範例明確是示意；fee income 不等於 net P&L。[Worked examples](https://business.1inch.com/portal/documentation/aqua/getting-started/worked-examples)

## 策略比較

以下「Provider 價值、風險與採用判斷」是研究推論，並非官方績效承諾。

| 方向 | Maker 的收益來源 | Provider 可提供什麼 | Aqua 落地方式 | 主要代價 |
|---|---|---|---|---|
| 全區間 XYC | 成交手續費及曲線定價 | token pair／費率選擇 | XYC + Fee | 資金效率、逆向選擇與庫存波動 |
| 動態集中流動性 | 活躍區間內成交費 | 價格分布估計、區間、重定位時機 | Concentrate + Fee，調整時 dock/ship | 出區間、頻繁重設成本、價格追逐 |
| 穩定／相關資產做市 | 小滑價下的成交費 | 錨定可信度、脫鉤訊號、曲線形狀 | PeggedSwap + Fee | 脫鉤時累积弱勢資產；不能假設一定回歸 |
| Decay 做市 | 改變成交後的套利價值分配 | decay 時間與市場狀態的映射 | Decay + 相容 AMM | 報價競爭力下降、狀態與時間依赖 |
| 庫存感知做市 | spread／fee，管理庫存風險 | fair price、方向性觀點、調整速度 | 自訂方向性定價／額度、或受限版本切換 | 不是現成單一 knob，需驗證成交時約束 |
| 多策略共享資金管理 | 多交易對／策略的可成交機會 | 選擇哪些策略啟用與分配額度 | 同一 wallet 多個 strategyHash | 超額承諾、競爭餘額、失敗成交 |

前三種與 Decay 的基礎分類來自 [SwapVM Programs Catalog](https://github.com/1inch/swap-vm/blob/main/docs/PROGRAMS.md)。多策略共享的官方例子組合 ETH／USDC、ETH／USDT 與 USDC／USDT，說明同一資產能服務不同交易對，但不是一份本金變成多份保證收益。[Aqua developer release](https://1inch.com/blog/post/aqua-developer-release)

## 庫存感知策略的真實依據

Avellaneda–Stoikov 研究做市者如何將庫存風險納入 reservation price 與買賣報價；這是訂單簿模型，不能直接當作 Aqua CLMM 的最佳解。[原論文](https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf)

Hummingbot 的 Inventory Skew 有可操作實例：依 base 資產市值占比改變 bid／ask 數量；base 太多就停止新 bid，太少就停止新 ask。這證明「Maker 提供目標庫存與容忍區間」是既有做市需求，並非為 TEE 虛構的欄位。[官方實作說明](https://hummingbot.org/strategies/v1-strategies/strategy-configs/inventory-skew/)

映射提案：Provider 提供市場估值與理想報價；Maker 提供目標庫存、額度和可接受偏離。TEE 決定是否提供雙邊流動性、縮小某方向、或停用。硬庫存限制仍需每筆成交檢查，不能只依賴定時 TEE 執行；價格變化本身也會改變市值占比。

CLMM 的價格、庫存與區間數學相互關聯。不能單純減少 USDC 額度便認定只是「降低買單」，也不能將偏移 CLMM 區間等同獨立 bid／ask skew。落地前要用實際 quote 驗證雙方向結果。

## Decay 與兩種 virtual balance

Mooniswap 的原始想法是以隨時間變化的虛擬餘額調整成交後價格，讓部分原本歸套利者的價值留給 LP；這不表示消除 MEV。[官方介紹](https://1inch.com/blog/post/1inch-revolutionizes-automated-market-maker-amm-segment-with-mooniswap)

注意：Aqua virtual balance 是資金使用記帳；Decay 的 virtual balance 是定價計算的狀態。兩者不是同一個功能。搭配 TEE 時，隱藏的是選擇 decay／啟停的模型；已啟用參數與成交仍可被觀察。

## 多策略風控是 Aqua 特有的重要需求

各策略額度獨立記帳，實際卻共用錢包。某策略先成交後，其他策略即使虛擬額度足夠，也可能因真实餘額不足而失敗。這不是自動借款或保證資金保留。[官方競爭與額度說明](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/access-resolvers-and-pathfinder)

因此 Maker policy 應以 wallet 整體額度為基準。保守方案限制總承諾，進階方案容許重疊但需顯式管理成交失敗風險。這是額度管理策略，不是收益 alpha，也不用因此增加新 sponsor。

## 參賽案例：能借鑑，但不可当績效證據

- [1Wave](https://ethglobal.com/showcase/1wave-9ypfs)：Aqua App 第四名，提出 oracle 驅動的 basket vault rebalancing。可參考「目標權重 → 做市」敘事；其消除 IL 宣稱未在本次研究驗證。
- [Coco](https://ethglobal.com/showcase/coco-dvaxo)：Aqua App 第二名，主打一般使用者的策略採用與風險呈現。不是公開量化策略研究，也不能從獎項推斷高收益成立。
- [Private Deals](https://ethglobal.com/showcase/private-deals-rqdm8)：拿 Aztec 獎，沒有 Aqua 得獎標記。作者坦承未解共享池成員過度使用資金的問題。提醒我們不要第一版混用多人共同資金。

## 本次研究判斷

首選研究主線：庫存感知做市。最貼近 Provider 的市場觀點與 Maker 的私人限制；但執行實作難度高於套用 CLMM。

落地基準：固定 XYC／CLMM，用同資料比較動態策略，而不是把基準本身稱作 alpha。

第二候選：穩定資產做市 + 脫鉤啟停；有清楚決策事件，但需真實訊號與承認停用延遲。

第三候選：CLMM + Decay；底層能力有據，需量化交易品質與流量取捨。只有切換參數的 UI 不足以证明策略優勢。

多策略覆蓋率做為共同風控需求，暫不擴張成另一個完整產品。

## 下一步研究與衡量

先選一個可追溯的市場資料來源和一個固定 baseline，對照不同 Maker 庫存政策。需要價格、雙方向成交／quote、gas 與版本變更資料。價格觸及區間不能直接當作會有成交。

衡量總資產 mark-to-market（扣成本）、相對持有策略差異、成交費、庫存偏離、drawdown、更新次數、過期報價損失與失敗成交。Fee 已包含在資產變化時不得重複加回；不能把 IL、markout 與價格損益不加區分地全部相減。

需要補證：實際 deployed router 支援、hackathon taker 測試途徑、自訂策略 routing 資格、真實 Maker 策略樣本與成交歷史。本次沒有取回帶交易 hash 的績效樣本，因此不報 APY、勝率或預期獲利。
