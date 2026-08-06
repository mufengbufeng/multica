package handler

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type SendCodeRequest struct {
	Email string `json:"email"`
}

type VerifyCodeRequest struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

type GoogleLoginRequest struct {
	Code        string `json:"code"`
	RedirectURI string `json:"redirect_uri"`
}

type googleTokenResponse struct {
	AccessToken string `json:"access_token"`
}

type googleUserInfo struct {
	Email         string `json:"email"`
	VerifiedEmail bool   `json:"verified_email"`
}

const (
	legacyVerificationCodeTTL = 10 * time.Minute
	legacyVerificationCodeGap = time.Minute
	googleTokenEndpoint       = "https://oauth2.googleapis.com/token"
	googleUserInfoEndpoint    = "https://www.googleapis.com/oauth2/v2/userinfo"
)

func generateLegacyVerificationCode() (string, error) {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	n := binary.BigEndian.Uint32(buf[:]) % 1_000_000
	return fmt.Sprintf("%06d", n), nil
}

func isSixDigitCode(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func (h *Handler) legacyAuthAllowed(w http.ResponseWriter, r *http.Request, route string) bool {
	// These headers are untrusted telemetry only. They help operators decide
	// when installed clients have migrated, but are never used for access.
	slog.Info("legacy auth route used", append(logger.RequestAttrs(r),
		"route", route,
		"client_platform", strings.TrimSpace(r.Header.Get("X-Client-Platform")),
		"client_version", strings.TrimSpace(r.Header.Get("X-Client-Version")),
	)...)
	if h.cfg.LegacyAuthEnabled {
		return true
	}
	writeError(w, http.StatusGone, "legacy authentication is disabled; upgrade your client")
	return false
}

func writeLegacyCodeSent(w http.ResponseWriter) {
	// Keep the old success shape while preventing this endpoint from becoming
	// an account-existence oracle after the password migration.
	writeJSON(w, http.StatusOK, map[string]string{"message": "Verification code sent"})
}

// SendCode is retained for installed clients during the migration window. It
// sends a code only to an existing account that has not enrolled a password;
// it never creates or provisions an account.
func (h *Handler) SendCode(w http.ResponseWriter, r *http.Request) {
	if !h.legacyAuthAllowed(w, r, "send-code") {
		return
	}
	if h.EmailService == nil || !h.EmailService.CanDeliver() {
		// Check transport availability before looking up the user, so a missing
		// email configuration cannot become an account-existence oracle.
		writeError(w, http.StatusServiceUnavailable, "email authentication is unavailable")
		return
	}

	var req SendCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	email, validEmail := normalizeEmail(req.Email)
	if !validEmail {
		writeError(w, http.StatusBadRequest, "a valid email address is required")
		return
	}
	if !h.allowAuthAttempt(w, r, email, true) {
		return
	}

	user, err := h.Queries.GetUserByEmail(r.Context(), email)
	if isNotFound(err) || (err == nil && user.PasswordHash.Valid) {
		writeLegacyCodeSent(w)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lookup user")
		return
	}

	latest, err := h.Queries.GetLatestCodeByEmail(r.Context(), email)
	if err == nil && latest.CreatedAt.Valid && time.Since(latest.CreatedAt.Time) < legacyVerificationCodeGap {
		writeLegacyCodeSent(w)
		return
	}
	if err != nil && !isNotFound(err) {
		writeError(w, http.StatusInternalServerError, "failed to lookup verification code")
		return
	}

	code, err := generateLegacyVerificationCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate verification code")
		return
	}
	if _, err := h.Queries.CreateVerificationCode(r.Context(), db.CreateVerificationCodeParams{
		Email:     email,
		Code:      code,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(legacyVerificationCodeTTL), Valid: true},
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store verification code")
		return
	}
	if err := h.EmailService.SendLegacyVerificationCode(email, code); err != nil {
		slog.Error("failed to send legacy verification code", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to send verification code")
		return
	}
	_ = h.Queries.DeleteExpiredVerificationCodes(r.Context())
	writeLegacyCodeSent(w)
}

// VerifyCode is retained for installed clients during the migration window.
// A valid mailbox code only authenticates a pre-existing passwordless account;
// it cannot create an account or take over a password-based account.
func (h *Handler) VerifyCode(w http.ResponseWriter, r *http.Request) {
	if !h.legacyAuthAllowed(w, r, "verify-code") {
		return
	}

	var req VerifyCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	email, validEmail := normalizeEmail(req.Email)
	code := strings.TrimSpace(req.Code)
	if !validEmail || !isSixDigitCode(code) {
		writeError(w, http.StatusBadRequest, "invalid or expired code")
		return
	}
	if !h.allowAuthAttempt(w, r, email, true) {
		return
	}

	user, err := h.Queries.GetUserByEmail(r.Context(), email)
	if isNotFound(err) || (err == nil && user.PasswordHash.Valid) {
		writeError(w, http.StatusBadRequest, "invalid or expired code")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lookup user")
		return
	}

	dbCode, err := h.Queries.GetLatestVerificationCode(r.Context(), email)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid or expired code")
		return
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(dbCode.Code)) != 1 {
		_ = h.Queries.IncrementVerificationCodeAttempts(r.Context(), dbCode.ID)
		writeError(w, http.StatusBadRequest, "invalid or expired code")
		return
	}
	if err := h.Queries.MarkVerificationCodeUsed(r.Context(), dbCode.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to verify code")
		return
	}

	h.resetAuthEmailLimit(r.Context(), email)
	h.writeLoginResponse(w, r, user)
}

// GoogleLogin retains the prior installed-client endpoint during the migration
// window. Google identity is proof only for an existing passwordless account;
// no user is created and a password-based account is never accepted here.
func (h *Handler) GoogleLogin(w http.ResponseWriter, r *http.Request) {
	if !h.legacyAuthAllowed(w, r, "google") {
		return
	}
	if !h.allowAuthAttempt(w, r, "", true) {
		return
	}

	var req GoogleLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Code) == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	clientID := strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_SECRET"))
	if clientID == "" || clientSecret == "" {
		writeError(w, http.StatusServiceUnavailable, "Google login is not configured")
		return
	}
	configuredRedirect := strings.TrimSpace(os.Getenv("GOOGLE_REDIRECT_URI"))
	redirectURI := strings.TrimSpace(req.RedirectURI)
	if redirectURI == "" {
		redirectURI = configuredRedirect
	}
	if configuredRedirect != "" && redirectURI != configuredRedirect {
		writeError(w, http.StatusBadRequest, "invalid Google redirect URI")
		return
	}

	form := url.Values{
		"code":          {req.Code},
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	}
	tokenReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, googleTokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create Google request")
		return
	}
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 10 * time.Second}
	tokenResp, err := client.Do(tokenReq)
	if err != nil {
		slog.Warn("google token exchange failed", "error", err)
		writeError(w, http.StatusBadGateway, "failed to exchange code with Google")
		return
	}
	defer tokenResp.Body.Close()
	if tokenResp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadRequest, "failed to exchange code with Google")
		return
	}
	var token googleTokenResponse
	if err := json.NewDecoder(tokenResp.Body).Decode(&token); err != nil || token.AccessToken == "" {
		writeError(w, http.StatusBadGateway, "failed to parse Google token response")
		return
	}

	userInfoReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, googleUserInfoEndpoint, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create Google request")
		return
	}
	userInfoReq.Header.Set("Authorization", "Bearer "+token.AccessToken)
	userInfoResp, err := client.Do(userInfoReq)
	if err != nil {
		slog.Warn("google userinfo request failed", "error", err)
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Google")
		return
	}
	defer userInfoResp.Body.Close()
	if userInfoResp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Google")
		return
	}
	var googleUser googleUserInfo
	if err := json.NewDecoder(userInfoResp.Body).Decode(&googleUser); err != nil || !googleUser.VerifiedEmail {
		writeError(w, http.StatusBadRequest, "Google account must have a verified email")
		return
	}
	email, validEmail := normalizeEmail(googleUser.Email)
	if !validEmail {
		writeError(w, http.StatusBadRequest, "Google account has no valid email")
		return
	}
	if !h.allowAuthAttempt(w, r, email, false) {
		return
	}

	user, err := h.Queries.GetUserByEmail(r.Context(), email)
	if isNotFound(err) || (err == nil && user.PasswordHash.Valid) {
		writeError(w, http.StatusUnauthorized, "Google account is not eligible for legacy login")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lookup user")
		return
	}

	h.resetAuthEmailLimit(r.Context(), email)
	h.writeLoginResponse(w, r, user)
}
