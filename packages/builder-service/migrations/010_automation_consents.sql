-- Explicit Maker opt-in for standing/event-driven report delivery. An LLM can
-- never create or confirm one; the signature is verified against the Maker.
CREATE TABLE builder.automation_consent_intents (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  artifact_id text NOT NULL,
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX automation_consent_intents_owner ON builder.automation_consent_intents(owner, created_at DESC);
CREATE TRIGGER immutable_automation_consent_intent BEFORE UPDATE OR DELETE ON builder.automation_consent_intents
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.automation_consents (
  id text PRIMARY KEY,
  owner text NOT NULL,
  intent_id text NOT NULL UNIQUE,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  artifact_id text NOT NULL,
  content_digest text NOT NULL,
  manifest_hash text NOT NULL,
  strategy_hash text NOT NULL,
  scope text NOT NULL CHECK (scope = 'standing-report-delivery'),
  expires_at timestamptz NOT NULL,
  message text NOT NULL,
  signature text NOT NULL,
  consent_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  FOREIGN KEY (intent_id) REFERENCES builder.automation_consent_intents(id),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX automation_consents_owner_current ON builder.automation_consents(owner, draft_id, created_at DESC);
CREATE TRIGGER immutable_automation_consent BEFORE UPDATE OR DELETE ON builder.automation_consents
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.automation_consent_revocations (
  consent_id text PRIMARY KEY,
  owner text NOT NULL,
  message text NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (consent_id) REFERENCES builder.automation_consents(id)
);
CREATE INDEX automation_revocations_owner ON builder.automation_consent_revocations(owner, created_at DESC);
CREATE TRIGGER immutable_automation_consent_revocation BEFORE UPDATE OR DELETE ON builder.automation_consent_revocations
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
