-- Dedicated namespace; no changes to legacy mandate state or Provider publications.
CREATE TABLE builder.conversations (
  id text PRIMARY KEY,
  owner text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner)
);
CREATE INDEX conversations_owner_updated ON builder.conversations (owner, updated_at DESC, id);

CREATE TABLE builder.drafts (
  id text PRIMARY KEY,
  owner text NOT NULL,
  conversation_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  UNIQUE (conversation_id, owner),
  FOREIGN KEY (conversation_id, owner) REFERENCES builder.conversations(id, owner)
);
CREATE INDEX drafts_owner_updated ON builder.drafts (owner, updated_at DESC, id);
CREATE TABLE builder.draft_revisions (
  draft_id text NOT NULL,
  owner text NOT NULL,
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL,
  digest text NOT NULL,
  diff jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (draft_id, revision),
  UNIQUE (draft_id, revision, owner),
  FOREIGN KEY (draft_id, owner) REFERENCES builder.drafts(id, owner)
);
CREATE INDEX revisions_owner_draft ON builder.draft_revisions (owner, draft_id, revision DESC);
CREATE FUNCTION builder.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record'; END;
$$;
CREATE TRIGGER immutable_revision BEFORE UPDATE OR DELETE ON builder.draft_revisions
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();

CREATE TABLE builder.messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  owner text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 16000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, owner) REFERENCES builder.conversations(id, owner)
);
CREATE INDEX messages_conversation_sequence ON builder.messages(conversation_id, owner, sequence);

CREATE TABLE builder.requests (
  owner text NOT NULL,
  request_id text NOT NULL,
  operation text NOT NULL,
  input_digest text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, request_id)
);

CREATE TABLE builder.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner text NOT NULL,
  kind text NOT NULL,
  resource_id text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  UNIQUE (kind, resource_id, revision)
);
CREATE INDEX outbox_pending ON builder.outbox(id) WHERE dispatched_at IS NULL;

CREATE TABLE builder.jobs (
  id text PRIMARY KEY,
  owner text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('agent-turn', 'simulation', 'evaluation')),
  resource_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  dedupe_key text NOT NULL,
  input_digest text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  result jsonb,
  UNIQUE (owner, kind, dedupe_key),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX jobs_claim ON builder.jobs(kind, available_at, created_at) WHERE state IN ('pending', 'running');
CREATE INDEX jobs_resource ON builder.jobs(owner, resource_id, generation, state);

CREATE TABLE builder.login_challenges (
  id text PRIMARY KEY,
  address text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX challenges_expiry ON builder.login_challenges(expires_at);
CREATE TABLE builder.sessions (
  token_hash text PRIMARY KEY,
  owner text NOT NULL,
  address text NOT NULL,
  audience text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sessions_owner ON builder.sessions(owner);
CREATE INDEX sessions_expiry ON builder.sessions(expires_at);
