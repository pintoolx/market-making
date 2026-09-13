-- Durable outbox delivery. Rows remain available for retry after a worker
-- restart; a lease prevents two replicas from dispatching the same row.
ALTER TABLE builder.outbox
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN lease_token text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN error_code text,
  ADD COLUMN dead_at timestamptz;
CREATE INDEX outbox_claim ON builder.outbox(available_at, id)
  WHERE dispatched_at IS NULL AND dead_at IS NULL;
