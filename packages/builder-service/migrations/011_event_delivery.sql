-- Durable event-driven standing authorization delivery. Public event input is
-- kept separate from private policy and every queued job is revision-bound.
CREATE TABLE builder.event_subscriptions (
  id text PRIMARY KEY,
  owner text NOT NULL,
  draft_id text NOT NULL,
  revision bigint NOT NULL,
  artifact_id text NOT NULL,
  consent_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  state text NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled','paused','stopped')),
  last_event_at timestamptz,
  last_input_observed_at timestamptz,
  last_evaluated_at timestamptz,
  last_changed_at timestamptz,
  last_report_hash text,
  last_report_nonce bigint,
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  UNIQUE (owner, draft_id, generation),
  FOREIGN KEY (draft_id, revision, owner) REFERENCES builder.draft_revisions(draft_id, revision, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner),
  FOREIGN KEY (consent_id, owner) REFERENCES builder.automation_consents(id, owner)
);
CREATE INDEX event_subscriptions_ready ON builder.event_subscriptions(state, updated_at);
CREATE INDEX event_subscriptions_owner ON builder.event_subscriptions(owner, draft_id, generation DESC);

CREATE TABLE builder.event_inbox (
  source text NOT NULL,
  event_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  observed_at timestamptz NOT NULL,
  chain_id bigint,
  block_number bigint,
  block_hash text,
  transaction_hash text,
  log_index integer,
  canonical boolean NOT NULL DEFAULT true,
  reorged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source, event_id)
);
CREATE INDEX event_inbox_pending ON builder.event_inbox(canonical, observed_at, source, event_id);

CREATE TABLE builder.event_cursors (
  source text PRIMARY KEY,
  chain_id bigint,
  cursor jsonb NOT NULL CHECK (jsonb_typeof(cursor) = 'object'),
  block_hash text,
  observed_at timestamptz,
  health text NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','stale','recovered','error')),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE builder.evaluation_jobs (
  id text PRIMARY KEY,
  subscription_id text NOT NULL,
  owner text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  source text NOT NULL,
  event_id text NOT NULL,
  input_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb,
  error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (subscription_id, generation, source, event_id),
  FOREIGN KEY (subscription_id, owner) REFERENCES builder.event_subscriptions(id, owner),
  FOREIGN KEY (source, event_id) REFERENCES builder.event_inbox(source, event_id),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX evaluation_jobs_claim ON builder.evaluation_jobs(state, available_at, created_at) WHERE state IN ('pending','running');
CREATE INDEX evaluation_jobs_owner ON builder.evaluation_jobs(owner, subscription_id, generation, created_at DESC);

CREATE TABLE builder.report_deliveries (
  id text PRIMARY KEY,
  subscription_id text NOT NULL,
  owner text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  evaluation_job_id text NOT NULL,
  report_hash text NOT NULL,
  nonce bigint NOT NULL CHECK (nonce >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','broadcast','accepted','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_hash text,
  receipt jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (subscription_id, generation, report_hash),
  FOREIGN KEY (subscription_id, owner) REFERENCES builder.event_subscriptions(id, owner),
  FOREIGN KEY (evaluation_job_id) REFERENCES builder.evaluation_jobs(id)
);
CREATE INDEX report_deliveries_pending ON builder.report_deliveries(status, next_attempt_at, created_at) WHERE status IN ('pending','broadcast');
CREATE INDEX report_deliveries_owner ON builder.report_deliveries(owner, subscription_id, created_at DESC);

CREATE TABLE builder.maker_report_sequences (
  owner text NOT NULL,
  strategy_hash text NOT NULL,
  next_nonce bigint NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, strategy_hash)
);
