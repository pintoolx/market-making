-- No arbitrary winner is selected if an older release left multiple strategies
-- enabled. Resolve that state explicitly before retrying this migration.
CREATE UNIQUE INDEX event_subscriptions_one_selected_maker
  ON builder.event_subscriptions(owner) WHERE state='enabled';

-- This lane is separate from Guard report nonce allocation: the CRE simulator
-- shares an Ethereum broadcaster across Makers. A started/uncertain delivery
-- occupies the lane until verified acceptance or definitive not-sent evidence.
CREATE TABLE builder.cre_delivery_attempts (
  delivery_id text PRIMARY KEY REFERENCES builder.report_deliveries(id),
  lane text NOT NULL,
  state text NOT NULL CHECK (state IN ('started','accepted','not-sent','reverted')),
  expected_digest text NOT NULL,
  from_block numeric(78,0) NOT NULL CHECK (from_block >= 0),
  transaction_hash text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX cre_delivery_one_inflight_broadcaster ON builder.cre_delivery_attempts(lane) WHERE state='started';
