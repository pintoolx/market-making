-- Keep every evaluation/report identity when a transaction is re-included.
-- A cancelled/orphaned occurrence must never overwrite its previous result.
ALTER TABLE builder.evaluation_jobs ADD COLUMN reorged_at timestamptz;
UPDATE builder.evaluation_jobs j SET reorged_at=COALESCE(i.reorged_at,clock_timestamp())
FROM builder.event_inbox i WHERE i.source=j.source AND i.event_id=j.event_id AND NOT i.canonical;

ALTER TABLE builder.evaluation_jobs
  DROP CONSTRAINT evaluation_jobs_subscription_id_generation_source_event_id_key;
CREATE UNIQUE INDEX evaluation_jobs_canonical_event
  ON builder.evaluation_jobs(subscription_id,generation,source,event_id)
  WHERE reorged_at IS NULL;
CREATE INDEX evaluation_jobs_event ON builder.evaluation_jobs(source,event_id);

UPDATE builder.report_deliveries d SET status='failed',error_code='event-reorged',updated_at=clock_timestamp()
FROM builder.evaluation_jobs j WHERE j.id=d.evaluation_job_id AND j.reorged_at IS NOT NULL AND d.status='pending';
