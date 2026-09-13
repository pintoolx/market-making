# Builder database

Builder persistence uses Railway PostgreSQL in the `pintool-backend` production project. The application schema, migrations, connection pool and worker behavior are documented in the `packages/builder-service` source, migrations and tests. A successful database connection alone is not evidence of application readiness.

## Provisioned infrastructure

| Resource | Configuration |
|---|---|
| Railway project | `b41aee7c-df3c-4c25-b3c0-a9307b8709fc` |
| Production environment | `7568291d-271e-4d79-8d9d-d1c29d9c6e24` |
| Postgres service | `5fac3033-a0ab-40a5-bfe1-7688e919aee0` |
| Database | `railway` |
| Verified server version | PostgreSQL 18.6, Debian 18.6-1.pgdg13+2 |
| Image | `ghcr.io/railwayapp-templates/postgres-ssl:18` |
| Region | `us-west2`, alongside mandate-service |
| Volume | 5,000 MB; `9e5b207b-24eb-4eee-8ad6-18a8ae7d0e4f` |
| Volume mount | `/var/lib/postgresql/data` |
| Verified deployment | `b7edc7ad-1b0a-4077-85d5-60c0c7a3d848` |

The service uses private networking without a public TCP proxy. The mandate-service (`0c9c45de-2aad-4f17-ae98-505369b1f28b`) configuration references `DATABASE_URL=${{Postgres.DATABASE_URL}}`; this is a Railway reference, not a credential.

At provisioning, the configuration update used `skipDeploys: true`, so it required a subsequent application deployment to take effect. Read-only SQL verified `current_database()`, `current_setting('server_version')` and `SELECT 1`. That operation did not run business migrations, move application state, restart the application or verify backup restoration. Temporary SSH keys were removed while existing keys were retained.

Use isolated databases for tests. Keep application data responsibilities separate: public conversations, draft revisions, immutable template versions, Maker instances, artifacts, simulations, confirmations, authorization bindings, event subscriptions, evaluation jobs, deliveries and chain cursors. Private policy plaintext must not enter ordinary database columns, conversation history or logs.
