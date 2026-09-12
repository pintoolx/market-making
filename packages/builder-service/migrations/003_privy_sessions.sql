-- Bind the wallet challenge to the verified app/user/session without storing its JWT.
ALTER TABLE builder.login_challenges ADD COLUMN privy_app_id text;
ALTER TABLE builder.login_challenges ADD COLUMN privy_user_id text;
ALTER TABLE builder.login_challenges ADD COLUMN privy_session_id text;
ALTER TABLE builder.sessions ADD COLUMN privy_app_id text;
ALTER TABLE builder.sessions ADD COLUMN privy_user_id text;
ALTER TABLE builder.sessions ADD COLUMN privy_session_id text;
ALTER TABLE builder.sessions ADD CONSTRAINT privy_session_complete CHECK (
  (privy_app_id IS NULL AND privy_user_id IS NULL AND privy_session_id IS NULL) OR
  (privy_app_id IS NOT NULL AND privy_user_id IS NOT NULL AND privy_session_id IS NOT NULL)
);
