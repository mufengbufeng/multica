CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_auth_login_rate_limit_bucket_key
ON auth_login_rate_limit (bucket_key);
