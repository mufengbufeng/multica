package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestDurableAuthRateLimitBlocksAfterConfiguredAttempts(t *testing.T) {
	const email = "durable-auth-rate-limit-test@multica.ai"
	originalConfig := testHandler.cfg
	testHandler.cfg.AuthPasswordEmailLimit = 2
	testHandler.cfg.AuthPasswordIPLimit = 50
	testHandler.cfg.AuthPasswordAttemptWindow = time.Minute
	t.Cleanup(func() { testHandler.cfg = originalConfig })

	request := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
		req.RemoteAddr = "198.51.100.44:12345"
		return req
	}
	ctx := context.Background()
	for _, scope := range []string{"email", "ip"} {
		if err := testHandler.Queries.ResetAuthRateLimit(ctx, authRateLimitBucket(scope, map[string]string{
			"email": email,
			"ip":    "198.51.100.44",
		}[scope])); err != nil {
			t.Fatalf("reset %s bucket: %v", scope, err)
		}
	}
	t.Cleanup(func() {
		_ = testHandler.Queries.ResetAuthRateLimit(context.Background(), authRateLimitBucket("email", email))
		_ = testHandler.Queries.ResetAuthRateLimit(context.Background(), authRateLimitBucket("ip", "198.51.100.44"))
	})

	for attempt := 1; attempt <= 2; attempt++ {
		w := httptest.NewRecorder()
		if !testHandler.allowAuthAttempt(w, request(), email, true) {
			t.Fatalf("attempt %d unexpectedly blocked: %d %s", attempt, w.Code, w.Body.String())
		}
	}

	w := httptest.NewRecorder()
	if testHandler.allowAuthAttempt(w, request(), email, true) {
		t.Fatal("third attempt must be blocked by the database-backed email limit")
	}
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("third attempt: expected 429, got %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("blocked auth attempt must include Retry-After")
	}
}

func TestLegacyAuthDisabledReturnsGoneBeforeDatabaseAccess(t *testing.T) {
	h := &Handler{cfg: Config{LegacyAuthEnabled: false}}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/send-code", nil)
	h.SendCode(w, req)

	if w.Code != http.StatusGone {
		t.Fatalf("legacy send-code: expected 410, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAuthClientIPUsesOnlyAuthTrustedProxies(t *testing.T) {
	proxy := netip.MustParsePrefix("127.0.0.1/32")
	h := &Handler{cfg: Config{AuthTrustedProxies: []netip.Prefix{proxy}}}
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.RemoteAddr = "127.0.0.1:43210"
	req.Header.Set("X-Forwarded-For", "198.51.100.44, 127.0.0.1")

	if got, want := h.authClientIP(req), "198.51.100.44"; got != want {
		t.Fatalf("trusted proxy client IP = %q, want %q", got, want)
	}

	h.cfg.AuthTrustedProxies = nil
	if got, want := h.authClientIP(req), "127.0.0.1"; got != want {
		t.Fatalf("untrusted proxy client IP = %q, want %q", got, want)
	}
}
