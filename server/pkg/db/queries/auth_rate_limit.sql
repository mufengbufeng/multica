-- name: ConsumeAuthRateLimit :one
INSERT INTO auth_login_rate_limit (bucket_key, window_started_at, attempt_count, updated_at)
VALUES (sqlc.arg(bucket_key), now(), 1, now())
ON CONFLICT (bucket_key) DO UPDATE
SET window_started_at = CASE
        WHEN auth_login_rate_limit.window_started_at <= now() - make_interval(secs => sqlc.arg(window_seconds)::integer)
            THEN now()
        ELSE auth_login_rate_limit.window_started_at
    END,
    attempt_count = CASE
        WHEN auth_login_rate_limit.window_started_at <= now() - make_interval(secs => sqlc.arg(window_seconds)::integer)
            THEN 1
        ELSE auth_login_rate_limit.attempt_count + 1
    END,
    updated_at = now()
RETURNING attempt_count, window_started_at;

-- name: ResetAuthRateLimit :exec
DELETE FROM auth_login_rate_limit
WHERE bucket_key = $1;

-- name: CleanupAuthRateLimits :exec
DELETE FROM auth_login_rate_limit
WHERE updated_at < now() - make_interval(secs => sqlc.arg(retention_seconds)::integer);
