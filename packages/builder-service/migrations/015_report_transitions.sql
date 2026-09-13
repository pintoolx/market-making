-- A report's effective terms may return after another regime. Deduplicate a
-- completed evaluation, not every historical occurrence of the same terms.
ALTER TABLE builder.report_deliveries
  DROP CONSTRAINT report_deliveries_subscription_id_generation_report_hash_key,
  ADD CONSTRAINT report_deliveries_evaluation_job_key UNIQUE (evaluation_job_id);

-- Guard report nonces are uint64; PostgreSQL bigint only covers signed int64.
ALTER TABLE builder.authorization_binding_intents
  ALTER COLUMN report_nonce TYPE numeric(20,0),
  ADD CONSTRAINT binding_intents_nonce_uint64 CHECK (report_nonce <= 18446744073709551615);
ALTER TABLE builder.authorization_bindings
  ALTER COLUMN report_nonce TYPE numeric(20,0),
  ADD CONSTRAINT bindings_nonce_uint64 CHECK (report_nonce <= 18446744073709551615);
ALTER TABLE builder.event_subscriptions
  ALTER COLUMN last_report_nonce TYPE numeric(20,0),
  ADD CONSTRAINT subscriptions_nonce_uint64 CHECK (last_report_nonce >= 0 AND last_report_nonce <= 18446744073709551615);
ALTER TABLE builder.report_deliveries
  ALTER COLUMN nonce TYPE numeric(20,0),
  ADD CONSTRAINT deliveries_nonce_uint64 CHECK (nonce <= 18446744073709551615);
ALTER TABLE builder.maker_report_sequences
  ALTER COLUMN next_nonce TYPE numeric(20,0),
  ADD CONSTRAINT sequences_nonce_uint64 CHECK (next_nonce <= 18446744073709551615);
