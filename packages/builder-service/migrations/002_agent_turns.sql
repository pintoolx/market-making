-- Durable public design work, separate from simulation and report delivery leases.
ALTER TABLE builder.messages ADD CONSTRAINT messages_identity_owner UNIQUE(id, conversation_id, owner);
ALTER TABLE builder.drafts ADD CONSTRAINT drafts_conversation_owner UNIQUE(id, conversation_id, owner);
CREATE TABLE builder.agent_turns (
  id text PRIMARY KEY,
  owner text NOT NULL,
  conversation_id text NOT NULL,
  draft_id text NOT NULL,
  message_id text NOT NULL,
  request_id text NOT NULL,
  input_digest text NOT NULL,
  accepted_revision bigint NOT NULL CHECK (accepted_revision > 0),
  last_revision bigint NOT NULL CHECK (last_revision >= accepted_revision),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled','superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token text,
  lease_until timestamptz,
  assistant_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (owner,request_id),
  UNIQUE (id,owner),
  FOREIGN KEY (draft_id,conversation_id,owner) REFERENCES builder.drafts(id,conversation_id,owner),
  FOREIGN KEY (message_id,conversation_id,owner) REFERENCES builder.messages(id,conversation_id,owner),
  FOREIGN KEY (assistant_message_id,conversation_id,owner) REFERENCES builder.messages(id,conversation_id,owner),
  CHECK ((state='running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX agent_turns_active ON builder.agent_turns(draft_id) WHERE state IN ('queued','running');
CREATE INDEX agent_turns_queue ON builder.agent_turns(created_at,id) WHERE state IN ('queued','running');
CREATE INDEX agent_turns_owner_created ON builder.agent_turns(owner,created_at DESC);
CREATE TABLE builder.agent_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id text NOT NULL,
  owner text NOT NULL,
  attempt integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('started','text','tool','completed','failed','cancelled','superseded')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(turn_id,owner) REFERENCES builder.agent_turns(id,owner)
);
CREATE INDEX agent_events_turn ON builder.agent_events(turn_id,owner,sequence);
