-- Each compiled order belongs to one immutable, owned draft revision and manifest.
CREATE TABLE builder.compiled_artifacts (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  UNIQUE (draft_id, revision, manifest_hash),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner)
);
CREATE INDEX compiled_artifacts_owner_draft ON builder.compiled_artifacts(owner, draft_id, revision DESC);
CREATE TRIGGER immutable_compiled_artifact BEFORE UPDATE OR DELETE ON builder.compiled_artifacts
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
