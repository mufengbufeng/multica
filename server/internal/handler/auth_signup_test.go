package handler

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func newTestHandler(cfg Config) *Handler {
	return &Handler{cfg: cfg}
}

// mockDB is shared by handler tests that exercise sqlc query error paths
// without a PostgreSQL connection.
type mockDB struct {
	db.DBTX
	getUserErr error
}

func (m *mockDB) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row {
	return &mockRow{err: m.getUserErr}
}

func (m *mockDB) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("INSERT 1"), nil
}

type mockRow struct {
	pgx.Row
	err error
}

func (m *mockRow) Scan(dest ...interface{}) error {
	return m.err
}

func TestSignupGating(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		email   string
		isNew   bool
		wantErr bool
	}{
		{"allow_signup_true_new", Config{AllowSignup: true}, "a@x.com", true, false},
		{"allow_signup_false_new", Config{AllowSignup: false}, "a@x.com", true, true},
		{"allow_signup_false_existing", Config{AllowSignup: false}, "a@x.com", false, false},
		{"domain_allowlist_match", Config{AllowSignup: false, AllowedEmailDomains: []string{"company.com"}}, "user@company.com", true, false},
		{"domain_allowlist_mismatch", Config{AllowSignup: false, AllowedEmailDomains: []string{"company.com"}}, "user@other.com", true, true},
		{"email_allowlist_match", Config{AllowSignup: false, AllowedEmails: []string{"boss@x.com"}}, "boss@x.com", true, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newTestHandler(tt.cfg)
			err := h.checkSignupAllowed(tt.email, tt.isNew)
			if (err != nil) != tt.wantErr {
				t.Fatalf("got err=%v wantErr=%v", err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeEmail(t *testing.T) {
	tests := []struct {
		input string
		want  string
		valid bool
	}{
		{" Alice@Example.com ", "alice@example.com", true},
		{"alice@example.com", "alice@example.com", true},
		{"alice@example.com (Alice)", "", false},
		{"not-an-email", "", false},
		{"", "", false},
	}

	for _, tt := range tests {
		got, valid := normalizeEmail(tt.input)
		if got != tt.want || valid != tt.valid {
			t.Fatalf("normalizeEmail(%q) = (%q, %t), want (%q, %t)", tt.input, got, valid, tt.want, tt.valid)
		}
	}
}

func TestValidatePassword(t *testing.T) {
	if err := validatePassword("short"); err == nil {
		t.Fatal("expected short password to be rejected")
	}
	if err := validatePassword("correct-password"); err != nil {
		t.Fatalf("expected valid password, got %v", err)
	}
	if err := validatePassword(strings.Repeat("a", maxPasswordLength+1)); err == nil {
		t.Fatal("expected overlong password to be rejected")
	}
}
