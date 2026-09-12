# Builder PostgreSQL

建立及驗證日期：2026-09-13（Asia/Taipei）。使用者指定 Builder 資料放 Railway PostgreSQL。

[Railway 資料庫服務](https://railway.com/project/b41aee7c-df3c-4c25-b3c0-a9307b8709fc/service/5fac3033-a0ab-40a5-bfe1-7688e919aee0?environmentId=7568291d-271e-4d79-8d9d-d1c29d9c6e24)

| 項目 | 實際建立結果 |
|---|---|
| Project | `pintool-backend` / `b41aee7c-df3c-4c25-b3c0-a9307b8709fc` |
| Environment | `production` / `7568291d-271e-4d79-8d9d-d1c29d9c6e24` |
| Service | `Postgres` / `5fac3033-a0ab-40a5-bfe1-7688e919aee0` |
| Database | `railway` |
| SQL 回報版本 | `18.6 (Debian 18.6-1.pgdg13+2)` |
| Template image | `ghcr.io/railwayapp-templates/postgres-ssl:18` |
| Region | `us-west2`，與 `mandate-service` 相同 |
| Volume | `postgres-volume` / `9e5b207b-24eb-4eee-8ad6-18a8ae7d0e4f`，5000 MB |
| Mount | `/var/lib/postgresql/data` |
| Verified deployment | `b7edc7ad-1b0a-4077-85d5-60c0c7a3d848`，`SUCCESS` |
| Networking | Railway private endpoint `postgres`；查核時無 public TCP proxy |

## 後端連線設定

`mandate-service`（`0c9c45de-2aad-4f17-ae98-505369b1f28b`）已設定 Railway reference variable：

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

這是非秘密的參照語法，實際帳密由 Railway 在環境內解析。不要將解析後的 URL 寫入前端、Git、對話或 log。

設定時使用 `skipDeploys: true`；**變數會在後端下次部署生效，本輪沒有為此重啟或部署 mandate-service**。既有程式仍需要新增 Postgres driver、migrations 和 Builder store 才會使用資料庫；建立 instance 不代表資料保存功能已接完。

本輪沒有修改既有 JSON mandate state、Provider registry 或 executor 資產 journal，也沒有建立 Builder 業務資料表或搬移舊資料。

## 實際驗證

1. 讀回 Railway 環境 inventory，確認服務、volume mount、region 與上述 deployment 的 `SUCCESS`。
2. 透過 Railway native SSH 在資料庫服務內執行 `psql`，由該服務既有 `PG*` 環境變數完成連線；沒有輸出帳密。
3. 執行唯讀 SQL：

```sql
SELECT current_database() AS database,
       current_setting('server_version') AS version,
       1 AS connection_ok;
```

結果：`railway | 18.6 (Debian 18.6-1.pgdg13+2) | 1`，`psql` exit 0。

4. 讀回 `mandate-service` 設定，確認 `DATABASE_URL` 已存在；TCP proxy 清單為空。
5. 驗證用臨時 SSH 公鑰已從 Railway 移除，臨時本機私鑰/公鑰也已刪除。既有 SSH keys 保留。

此驗證證明 PostgreSQL 已啟動並可接受 SQL 連線，不代表已驗證 Builder 的資料表、應用程式連線池、備份恢復或業務交易。

後續實作依 [Builder handoff](SWAPVM-STRATEGY-BUILDER-HANDOFF.md) 和 [AI 整合提案](SWAPVM-BUILDER-AI-IMPLEMENTATION.md)，以此 instance 建立 migrations、owner/revision 隔離、模板版本、模擬工作與續期紀錄。
