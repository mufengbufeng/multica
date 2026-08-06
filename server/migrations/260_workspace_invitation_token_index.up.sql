CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_workspace_invitation_token_hash
ON workspace_invitation (token_hash)
WHERE token_hash IS NOT NULL;
