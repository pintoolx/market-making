CREATE TABLE builder.scenario_previews (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  engine_version text NOT NULL,
  input_digest text NOT NULL,
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs)='object'),
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (draft_id,revision,manifest_hash,engine_version,input_digest),
  FOREIGN KEY (draft_id,revision,owner) REFERENCES builder.draft_revisions(draft_id,revision,owner)
);
CREATE INDEX scenario_previews_owner_draft ON builder.scenario_previews(owner,draft_id,revision DESC,created_at DESC);
CREATE INDEX scenario_previews_owner_created ON builder.scenario_previews(owner,created_at DESC);
CREATE TRIGGER immutable_scenario_preview BEFORE UPDATE OR DELETE ON builder.scenario_previews
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
