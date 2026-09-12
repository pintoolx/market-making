-- Generic jobs retain queue/lease state. Inputs and completed evidence are immutable owned records.
ALTER TABLE builder.jobs ADD CONSTRAINT jobs_id_owner UNIQUE (id, owner);
CREATE TABLE builder.simulation_runs (
  id text PRIMARY KEY,
  owner text NOT NULL,
  artifact_id text NOT NULL,
  engine_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner),
  FOREIGN KEY (id, owner) REFERENCES builder.jobs(id, owner),
  FOREIGN KEY (artifact_id, owner) REFERENCES builder.compiled_artifacts(id, owner)
);
CREATE INDEX simulation_runs_artifact ON builder.simulation_runs(artifact_id, created_at DESC);
CREATE INDEX simulation_runs_owner_created ON builder.simulation_runs(owner, created_at DESC);
CREATE INDEX simulation_jobs_owner_created ON builder.jobs(owner, created_at DESC) WHERE kind='simulation';
CREATE TRIGGER immutable_simulation_run BEFORE UPDATE OR DELETE ON builder.simulation_runs
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
CREATE TABLE builder.simulation_results (
  run_id text PRIMARY KEY,
  owner text NOT NULL,
  payload_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, owner) REFERENCES builder.simulation_runs(id, owner)
);
CREATE TRIGGER immutable_simulation_result BEFORE UPDATE OR DELETE ON builder.simulation_results
  FOR EACH ROW EXECUTE FUNCTION builder.immutable_record();
