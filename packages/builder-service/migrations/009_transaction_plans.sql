-- Unsigned wallet plans. They are immutable evidence of what the user may review;
-- this table never stores signatures, private keys or broadcast receipts.
CREATE TABLE builder.transaction_plans (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  artifact_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('registration','cancellation')),
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  strategy_hash text NOT NULL,
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX transaction_plans_owner_created ON builder.transaction_plans(owner, created_at DESC);
CREATE INDEX transaction_plans_draft_kind ON builder.transaction_plans(owner, draft_id, kind, created_at DESC);
CREATE TRIGGER immutable_transaction_plan BEFORE UPDATE OR DELETE ON builder.transaction_plans
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
