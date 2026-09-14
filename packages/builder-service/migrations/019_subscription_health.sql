CREATE TABLE builder.subscription_health (
  subscription_id text PRIMARY KEY REFERENCES builder.event_subscriptions(id),
  pause_required boolean NOT NULL,
  unavailable jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
