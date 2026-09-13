-- Trusted binding evidence joins a Maker wallet, exact compiled order and an
-- independently verified standing report. It is never minted by the model.
CREATE TABLE builder.authorization_binding_intents (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  artifact_id text NOT NULL,
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  maker text NOT NULL,
  guard text NOT NULL,
  router text NOT NULL,
  strategy_hash text NOT NULL,
  program_hash text NOT NULL,
  order_hash text NOT NULL,
  report_schema integer NOT NULL CHECK (report_schema = 2),
  report_digest text NOT NULL,
  report_transaction_hash text NOT NULL,
  report_nonce bigint NOT NULL CHECK (report_nonce > 0),
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX binding_intents_owner_created ON builder.authorization_binding_intents(owner, created_at DESC);
CREATE TRIGGER immutable_binding_intent BEFORE UPDATE OR DELETE ON builder.authorization_binding_intents
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.authorization_bindings (
  id text PRIMARY KEY,
  owner text NOT NULL,
  intent_id text NOT NULL UNIQUE,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  artifact_id text NOT NULL,
  manifest_hash text NOT NULL,
  content_digest text NOT NULL,
  maker text NOT NULL,
  guard text NOT NULL,
  router text NOT NULL,
  strategy_hash text NOT NULL,
  program_hash text NOT NULL,
  order_hash text NOT NULL,
  report_schema integer NOT NULL CHECK (report_schema = 2),
  report_digest text NOT NULL,
  report_transaction_hash text NOT NULL,
  report_nonce bigint NOT NULL CHECK (report_nonce > 0),
  maker_message text NOT NULL,
  maker_signature text NOT NULL,
  binding_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  FOREIGN KEY (intent_id, owner) REFERENCES builder.authorization_binding_intents(id, owner),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX authorization_bindings_owner_current ON builder.authorization_bindings(owner, draft_id, revision, created_at DESC);
CREATE TRIGGER immutable_authorization_binding BEFORE UPDATE OR DELETE ON builder.authorization_bindings
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
