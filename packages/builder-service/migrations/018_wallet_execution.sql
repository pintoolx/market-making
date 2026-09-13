ALTER TABLE builder.transaction_plans DROP CONSTRAINT transaction_plans_kind_check;
ALTER TABLE builder.transaction_plans ADD CONSTRAINT transaction_plans_kind_check
  CHECK (kind IN ('registration','cancellation','guard-revoke','guard-unrevoke','allowance-revoke'));

-- The user wallet signs. This journal stores only public requests and chain evidence.
CREATE TABLE builder.wallet_executions (
  id text PRIMARY KEY,
  owner text NOT NULL,
  plan_id text NOT NULL REFERENCES builder.transaction_plans(id),
  step integer NOT NULL CHECK (step >= 0 AND step < 3),
  state text NOT NULL CHECK (state IN ('awaiting-wallet','pending','unverified','confirmed','reverted','replaced','rejected')),
  version bigint NOT NULL DEFAULT 0,
  nonce numeric(20,0) NOT NULL CHECK (nonce >= 0),
  from_block numeric(78,0) NOT NULL,
  request jsonb NOT NULL,
  request_digest text NOT NULL,
  transaction_hash text,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX wallet_execution_unresolved_owner ON builder.wallet_executions(owner)
  WHERE state IN ('awaiting-wallet','pending');
CREATE INDEX wallet_execution_plan ON builder.wallet_executions(owner,plan_id,created_at);
