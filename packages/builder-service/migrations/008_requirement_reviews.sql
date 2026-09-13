-- Exact public interpretation/evidence review and the user's separate decisions.
-- No private policy, model-generated acceptance or asset signature is stored here.
CREATE TABLE builder.requirement_review_intents (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  artifact_id text,
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX review_intents_owner_created ON builder.requirement_review_intents(owner, created_at DESC);
CREATE INDEX review_intents_draft_revision ON builder.requirement_review_intents(owner, draft_id, revision);
CREATE TRIGGER immutable_requirement_review_intent BEFORE UPDATE OR DELETE ON builder.requirement_review_intents
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.requirement_review_receipts (
  intent_id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  decision_digest text NOT NULL,
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (intent_id, owner) REFERENCES builder.requirement_review_intents(id, owner),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner)
);
CREATE INDEX review_receipts_current ON builder.requirement_review_receipts(owner, draft_id, revision, manifest_hash, created_at DESC);
CREATE TRIGGER immutable_requirement_review_receipt BEFORE UPDATE OR DELETE ON builder.requirement_review_receipts
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
