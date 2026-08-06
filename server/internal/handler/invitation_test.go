package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/auth"
)

const invitationTestEmail = "invitation-test@multica.ai"

type invitationTestEmailDelivery struct {
	invitationTokens chan string
}

func newInvitationTestEmailDelivery() *invitationTestEmailDelivery {
	return &invitationTestEmailDelivery{invitationTokens: make(chan string, 4)}
}

func (d *invitationTestEmailDelivery) CanDeliver() bool { return true }

func (d *invitationTestEmailDelivery) CanDeliverInvitations() bool { return true }

func (d *invitationTestEmailDelivery) SendLegacyVerificationCode(_, _ string) error { return nil }

func (d *invitationTestEmailDelivery) SendInvitationEmail(_, _, _, _, token string) error {
	select {
	case d.invitationTokens <- token:
	default:
	}
	return nil
}

func (d *invitationTestEmailDelivery) waitForInvitationToken(t *testing.T) string {
	t.Helper()
	select {
	case token := <-d.invitationTokens:
		return token
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for invitation capability delivery")
		return ""
	}
}

func useInvitationTestEmailDelivery(t *testing.T) *invitationTestEmailDelivery {
	t.Helper()
	delivery := newInvitationTestEmailDelivery()
	previous := testHandler.EmailService
	testHandler.EmailService = delivery
	t.Cleanup(func() { testHandler.EmailService = previous })
	return delivery
}

func clearInvitationsForTestWorkspace(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	if _, err := testPool.Exec(ctx,
		`DELETE FROM workspace_invitation WHERE workspace_id = $1`,
		parseUUID(testWorkspaceID),
	); err != nil {
		t.Fatalf("clear invitations: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM workspace_invitation WHERE workspace_id = $1`,
			parseUUID(testWorkspaceID),
		)
	})
}

// Sanity check: a fresh, live pending invitation must block re-invitation.
func TestCreateInvitation_BlocksWhilePending(t *testing.T) {
	clearInvitationsForTestWorkspace(t)
	useInvitationTestEmailDelivery(t)

	req := newRequest("POST", "/api/workspaces/"+testWorkspaceID+"/members", CreateMemberRequest{
		Email: invitationTestEmail,
		Role:  "member",
	})
	req = withURLParam(req, "id", testWorkspaceID)
	w := httptest.NewRecorder()
	testHandler.CreateInvitation(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("first invite: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	req2 := newRequest("POST", "/api/workspaces/"+testWorkspaceID+"/members", CreateMemberRequest{
		Email: invitationTestEmail,
		Role:  "member",
	})
	req2 = withURLParam(req2, "id", testWorkspaceID)
	w2 := httptest.NewRecorder()
	testHandler.CreateInvitation(w2, req2)
	if w2.Code != http.StatusConflict {
		t.Fatalf("second invite: expected 409 while still pending, got %d: %s", w2.Code, w2.Body.String())
	}
}

// Regression for issue #2055: an expired pending invitation must NOT block a
// new invitation to the same email. The stale row should be flipped to
// 'expired' and a fresh pending row should be created.
func TestCreateInvitation_AllowsAfterExpiry(t *testing.T) {
	clearInvitationsForTestWorkspace(t)
	useInvitationTestEmailDelivery(t)
	ctx := context.Background()

	var staleID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace_invitation (
			workspace_id, inviter_id, invitee_email, role, status, created_at, updated_at, expires_at
		)
		VALUES ($1, $2, $3, 'member', 'pending', now() - interval '10 days', now() - interval '10 days', now() - interval '3 days')
		RETURNING id
	`, parseUUID(testWorkspaceID), parseUUID(testUserID), invitationTestEmail).Scan(&staleID); err != nil {
		t.Fatalf("seed expired invitation: %v", err)
	}

	req := newRequest("POST", "/api/workspaces/"+testWorkspaceID+"/members", CreateMemberRequest{
		Email: invitationTestEmail,
		Role:  "member",
	})
	req = withURLParam(req, "id", testWorkspaceID)
	w := httptest.NewRecorder()
	testHandler.CreateInvitation(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("re-invite after expiry: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp InvitationResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ID == "" || resp.ID == staleID {
		t.Fatalf("expected a new invitation row, got id=%q (stale=%q)", resp.ID, staleID)
	}

	var staleStatus string
	if err := testPool.QueryRow(ctx,
		`SELECT status FROM workspace_invitation WHERE id = $1`, staleID,
	).Scan(&staleStatus); err != nil {
		t.Fatalf("read stale row: %v", err)
	}
	if staleStatus != "expired" {
		t.Fatalf("expected stale row to be 'expired', got %q", staleStatus)
	}

	var pendingCount int
	if err := testPool.QueryRow(ctx, `
		SELECT COUNT(*) FROM workspace_invitation
		WHERE workspace_id = $1 AND invitee_email = $2 AND status = 'pending'
	`, parseUUID(testWorkspaceID), invitationTestEmail).Scan(&pendingCount); err != nil {
		t.Fatalf("count pending: %v", err)
	}
	if pendingCount != 1 {
		t.Fatalf("expected exactly 1 pending invitation after re-invite, got %d", pendingCount)
	}
}

// A matching email address is delivery metadata only. A user must present the
// high-entropy capability delivered in the invitation email before the row is
// bound to their account.
func TestInvitationClaimRequiresDeliveredCapability(t *testing.T) {
	clearInvitationsForTestWorkspace(t)
	delivery := useInvitationTestEmailDelivery(t)
	ctx := context.Background()
	const email = "invitation-capability-claim@multica.ai"

	var claimantID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email)
		VALUES ('Invitation Capability Claimant', $1)
		RETURNING id
	`, email).Scan(&claimantID); err != nil {
		t.Fatalf("create claimant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, claimantID)
	})

	createReq := newRequest(http.MethodPost, "/api/workspaces/"+testWorkspaceID+"/members", CreateMemberRequest{
		Email: email,
		Role:  "member",
	})
	createReq = withURLParam(createReq, "id", testWorkspaceID)
	createW := httptest.NewRecorder()
	testHandler.CreateInvitation(createW, createReq)
	if createW.Code != http.StatusCreated {
		t.Fatalf("create invitation: expected 201, got %d: %s", createW.Code, createW.Body.String())
	}

	var invitation InvitationResponse
	if err := json.NewDecoder(createW.Body).Decode(&invitation); err != nil {
		t.Fatalf("decode invitation: %v", err)
	}
	token := delivery.waitForInvitationToken(t)
	if token == "" || strings.Contains(createW.Body.String(), token) {
		t.Fatal("invitation capability must be delivered separately, not returned by the API")
	}

	var storedHash string
	if err := testPool.QueryRow(ctx, `SELECT token_hash FROM workspace_invitation WHERE id = $1`, invitation.ID).Scan(&storedHash); err != nil {
		t.Fatalf("read invitation token hash: %v", err)
	}
	if storedHash != auth.HashToken(token) || storedHash == token {
		t.Fatal("invitation capability must be persisted only as its hash")
	}

	listReq := newRequest(http.MethodGet, "/api/invitations", nil)
	listReq.Header.Set("X-User-ID", claimantID)
	listW := httptest.NewRecorder()
	testHandler.ListMyInvitations(listW, listReq)
	if listW.Code != http.StatusOK {
		t.Fatalf("list invitations: expected 200, got %d: %s", listW.Code, listW.Body.String())
	}
	var listed []InvitationResponse
	if err := json.NewDecoder(listW.Body).Decode(&listed); err != nil {
		t.Fatalf("decode invitation list: %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("email-only account must not see an unclaimed invitation: %+v", listed)
	}

	claim := func(capability string) *httptest.ResponseRecorder {
		req := newRequest(http.MethodPost, "/api/invitations/"+invitation.ID+"/claim", ClaimInvitationRequest{Token: capability})
		req.Header.Set("X-User-ID", claimantID)
		req = withURLParam(req, "id", invitation.ID)
		w := httptest.NewRecorder()
		testHandler.ClaimInvitation(w, req)
		return w
	}
	if wrong := claim(strings.Repeat("x", len(token))); wrong.Code != http.StatusNotFound {
		t.Fatalf("claim with wrong capability: expected 404, got %d: %s", wrong.Code, wrong.Body.String())
	}
	if claimed := claim(token); claimed.Code != http.StatusOK {
		t.Fatalf("claim with delivered capability: expected 200, got %d: %s", claimed.Code, claimed.Body.String())
	}

	var boundUserID string
	if err := testPool.QueryRow(ctx, `SELECT invitee_user_id::text FROM workspace_invitation WHERE id = $1`, invitation.ID).Scan(&boundUserID); err != nil {
		t.Fatalf("read invitation claimant: %v", err)
	}
	if boundUserID != claimantID {
		t.Fatalf("invitation claimant = %q, want %q", boundUserID, claimantID)
	}
}
