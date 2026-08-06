CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auth_login_rate_limit_updated_at
ON auth_login_rate_limit (updated_at);
