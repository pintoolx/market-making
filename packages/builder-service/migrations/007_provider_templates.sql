CREATE TABLE builder.provider_templates (
  id text PRIMARY KEY,
  owner text NOT NULL,
  latest_version bigint NOT NULL DEFAULT 0 CHECK (latest_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,owner)
);
CREATE INDEX provider_templates_owner ON builder.provider_templates(owner,created_at DESC);

CREATE TABLE builder.publication_intents (
  id text PRIMARY KEY,
  owner text NOT NULL,
  template_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (template_id,owner) REFERENCES builder.provider_templates(id,owner),
  FOREIGN KEY (draft_id,revision,owner) REFERENCES builder.draft_revisions(draft_id,revision,owner)
);
CREATE INDEX publication_intents_owner_created ON builder.publication_intents(owner,created_at DESC);
CREATE TRIGGER immutable_publication_intent BEFORE UPDATE OR DELETE ON builder.publication_intents
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.template_versions (
  template_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  owner text NOT NULL,
  intent_id text NOT NULL UNIQUE REFERENCES builder.publication_intents(id),
  digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (template_id,version),
  UNIQUE (template_id,version,owner),
  FOREIGN KEY (template_id,owner) REFERENCES builder.provider_templates(id,owner)
);
CREATE INDEX template_versions_public_latest ON builder.template_versions(created_at DESC,template_id);
CREATE TRIGGER immutable_template_version BEFORE UPDATE OR DELETE ON builder.template_versions
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

-- Separate namespace, no plaintext and no envelope copies in requests/outbox/model events.
-- Rollout grants this schema only to the publication writer and trusted delivery worker.
CREATE SCHEMA builder_private;
REVOKE ALL ON SCHEMA builder_private FROM PUBLIC;
CREATE TABLE builder_private.provider_policies (
  template_id text NOT NULL,
  version bigint NOT NULL,
  key_id text NOT NULL,
  envelope_digest text NOT NULL,
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  PRIMARY KEY (template_id,version),
  FOREIGN KEY (template_id,version) REFERENCES builder.template_versions(template_id,version)
);
REVOKE ALL ON builder_private.provider_policies FROM PUBLIC;
CREATE TRIGGER immutable_provider_policy BEFORE UPDATE OR DELETE ON builder_private.provider_policies
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.template_withdrawals (
  template_id text NOT NULL,
  version bigint NOT NULL,
  owner text NOT NULL,
  signature text NOT NULL,
  origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (template_id,version),
  FOREIGN KEY (template_id,version,owner) REFERENCES builder.template_versions(template_id,version,owner)
);
CREATE TRIGGER immutable_template_withdrawal BEFORE UPDATE OR DELETE ON builder.template_withdrawals
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.template_instances (
  draft_id text PRIMARY KEY,
  owner text NOT NULL,
  initial_revision bigint NOT NULL CHECK (initial_revision=1),
  template_id text NOT NULL,
  version bigint NOT NULL,
  template_digest text NOT NULL,
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline)='object'),
  baseline_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (draft_id,initial_revision,owner) REFERENCES builder.draft_revisions(draft_id,revision,owner),
  FOREIGN KEY (template_id,version) REFERENCES builder.template_versions(template_id,version)
);
CREATE INDEX template_instances_version ON builder.template_instances(template_id,version);
CREATE INDEX template_instances_owner_created ON builder.template_instances(owner,created_at DESC);
CREATE TRIGGER immutable_template_instance BEFORE UPDATE OR DELETE ON builder.template_instances
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
