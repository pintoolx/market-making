-- Bind an event subscription to one public source. The wildcard keeps
-- existing subscriptions compatible while allowing new ones to opt in to a
-- single market or chain adapter.
ALTER TABLE builder.event_subscriptions
  ADD COLUMN source text NOT NULL DEFAULT '*',
  ADD CONSTRAINT event_subscriptions_source_format
    CHECK (source = '*' OR source ~ '^[a-z][a-z0-9._-]{0,63}$');
CREATE INDEX event_subscriptions_source_ready ON builder.event_subscriptions(source, state, updated_at);

-- A public event can notify multiple Makers at the same revision. Deduplicate
-- retries within each owner instead of dropping the other recipients.
ALTER TABLE builder.outbox
  DROP CONSTRAINT outbox_kind_resource_id_revision_key,
  ADD CONSTRAINT outbox_owner_kind_resource_id_revision_key UNIQUE (owner, kind, resource_id, revision);
