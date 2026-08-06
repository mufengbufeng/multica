package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/auth"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	defaultAuthPasswordEmailLimit    = 5
	defaultAuthPasswordIPLimit       = 20
	defaultAuthPasswordAttemptWindow = 15 * time.Minute
	authRateLimitRetention           = 24 * time.Hour
	authRateLimitCleanupInterval     = time.Hour
)

func normalizeAuthRateLimitConfig(cfg *Config) {
	if cfg.AuthPasswordEmailLimit <= 0 {
		cfg.AuthPasswordEmailLimit = defaultAuthPasswordEmailLimit
	}
	if cfg.AuthPasswordIPLimit <= 0 {
		cfg.AuthPasswordIPLimit = defaultAuthPasswordIPLimit
	}
	if cfg.AuthPasswordAttemptWindow <= 0 {
		cfg.AuthPasswordAttemptWindow = defaultAuthPasswordAttemptWindow
	}
}

// allowAuthAttempt is the durable auth throttle. It stores only a keyed hash
// of the email or client IP, so database readers cannot recover either value.
// It intentionally fails closed: a public password endpoint must not become
// unlimited just because Redis is absent or a database limiter query fails.
func (h *Handler) allowAuthAttempt(w http.ResponseWriter, r *http.Request, email string, includeIP bool) bool {
	if h.Queries == nil {
		writeError(w, http.StatusServiceUnavailable, "authentication is temporarily unavailable")
		return false
	}

	if email != "" && !h.consumeAuthRateLimit(w, r, "email", email, h.cfg.AuthPasswordEmailLimit) {
		return false
	}
	if includeIP && !h.consumeAuthRateLimit(w, r, "ip", h.authClientIP(r), h.cfg.AuthPasswordIPLimit) {
		return false
	}

	h.maybeCleanupAuthRateLimits(r.Context())
	return true
}

func (h *Handler) consumeAuthRateLimit(w http.ResponseWriter, r *http.Request, scope, value string, limit int) bool {
	windowSeconds := int32(h.cfg.AuthPasswordAttemptWindow / time.Second)
	if windowSeconds <= 0 {
		windowSeconds = int32(defaultAuthPasswordAttemptWindow / time.Second)
	}

	row, err := h.Queries.ConsumeAuthRateLimit(r.Context(), db.ConsumeAuthRateLimitParams{
		BucketKey:     authRateLimitBucket(scope, value),
		WindowSeconds: windowSeconds,
	})
	if err != nil {
		slog.Error("auth rate limit unavailable", "scope", scope, "error", err)
		writeError(w, http.StatusServiceUnavailable, "authentication is temporarily unavailable")
		return false
	}
	if row.AttemptCount <= int32(limit) {
		return true
	}

	retryAfter := h.cfg.AuthPasswordAttemptWindow
	if row.WindowStartedAt.Valid {
		retryAfter -= time.Since(row.WindowStartedAt.Time)
	}
	if retryAfter < time.Second {
		retryAfter = time.Second
	}
	w.Header().Set("Retry-After", formatRetryAfter(retryAfter))
	writeError(w, http.StatusTooManyRequests, "too many authentication attempts")
	return false
}

func (h *Handler) resetAuthEmailLimit(ctx context.Context, email string) {
	if h.Queries == nil || email == "" {
		return
	}
	if err := h.Queries.ResetAuthRateLimit(ctx, authRateLimitBucket("email", email)); err != nil {
		slog.Warn("reset auth rate limit failed", "error", err)
	}
}

func (h *Handler) maybeCleanupAuthRateLimits(ctx context.Context) {
	now := time.Now()
	h.authRateLimitCleanupMu.Lock()
	if now.Before(h.nextAuthRateLimitCleanup) {
		h.authRateLimitCleanupMu.Unlock()
		return
	}
	h.nextAuthRateLimitCleanup = now.Add(authRateLimitCleanupInterval)
	h.authRateLimitCleanupMu.Unlock()

	if err := h.Queries.CleanupAuthRateLimits(ctx, int32(authRateLimitRetention/time.Second)); err != nil {
		slog.Warn("cleanup auth rate limits failed", "error", err)
	}
}

func authRateLimitBucket(scope, value string) string {
	mac := hmac.New(sha256.New, auth.JWTSecret())
	_, _ = mac.Write([]byte("multica:auth-rate-limit:v1:"))
	_, _ = mac.Write([]byte(scope))
	_, _ = mac.Write([]byte(":"))
	_, _ = mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

func (h *Handler) authClientIP(r *http.Request) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = strings.TrimSpace(r.RemoteAddr)
	}
	remoteAddr, parsedRemote := netip.ParseAddr(remoteHost)

	if parsedRemote == nil && h.isTrustedAuthProxy(remoteAddr) {
		for _, part := range reverseCommaSeparated(r.Header.Get("X-Forwarded-For")) {
			candidate, err := netip.ParseAddr(part)
			if err == nil && !h.isTrustedAuthProxy(candidate) {
				return candidate.String()
			}
		}
	}

	if parsedRemote == nil {
		return remoteAddr.String()
	}
	if remoteHost == "" {
		return "unknown"
	}
	return remoteHost
}

func (h *Handler) isTrustedAuthProxy(addr netip.Addr) bool {
	for _, prefix := range h.cfg.AuthTrustedProxies {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func reverseCommaSeparated(raw string) []string {
	parts := strings.Split(raw, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	for left, right := 0, len(parts)-1; left < right; left, right = left+1, right-1 {
		parts[left], parts[right] = parts[right], parts[left]
	}
	return parts
}

func formatRetryAfter(d time.Duration) string {
	seconds := int64(d.Seconds())
	if time.Duration(seconds)*time.Second < d {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}
