package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ProjectResourceResponse is the JSON shape returned by the project resource API.
type ProjectResourceResponse struct {
	ID           string          `json:"id"`
	ProjectID    string          `json:"project_id"`
	WorkspaceID  string          `json:"workspace_id"`
	ResourceType string          `json:"resource_type"`
	ResourceRef  json.RawMessage `json:"resource_ref"`
	Label        *string         `json:"label"`
	Position     int32           `json:"position"`
	CreatedAt    string          `json:"created_at"`
	CreatedBy    *string         `json:"created_by"`
}

func projectResourceToResponse(r db.ProjectResource) ProjectResourceResponse {
	ref := json.RawMessage(r.ResourceRef)
	if len(ref) == 0 {
		ref = json.RawMessage("{}")
	}
	return ProjectResourceResponse{
		ID:           uuidToString(r.ID),
		ProjectID:    uuidToString(r.ProjectID),
		WorkspaceID:  uuidToString(r.WorkspaceID),
		ResourceType: r.ResourceType,
		ResourceRef:  ref,
		Label:        textToPtr(r.Label),
		Position:     r.Position,
		CreatedAt:    timestampToString(r.CreatedAt),
		CreatedBy:    uuidToPtr(r.CreatedBy),
	}
}

// CreateProjectResourceRequest is the body for POST /api/projects/{id}/resources.
type CreateProjectResourceRequest struct {
	ResourceType string          `json:"resource_type"`
	ResourceRef  json.RawMessage `json:"resource_ref"`
	Label        *string         `json:"label"`
	Position     *int32          `json:"position"`
}

// UpdateProjectResourceRequest is the body for PUT /api/projects/{id}/resources/{resourceId}.
// resource_type cannot change after creation — pick a new type by deleting and
// re-adding. Every field is optional; omitted fields keep their current value.
type UpdateProjectResourceRequest struct {
	ResourceRef json.RawMessage `json:"resource_ref"`
	Label       *string         `json:"label"`
	Position    *int32          `json:"position"`
}

// validateAndNormalizeResourceRef checks the payload for a known resource_type.
// New types are added here without schema migration; unknown types are rejected
// at the API boundary so a typo can't slip through and produce a resource the
// daemon/UI doesn't understand.
func validateAndNormalizeResourceRef(resourceType string, ref json.RawMessage) (json.RawMessage, error) {
	if len(ref) == 0 {
		return nil, errors.New("resource_ref is required")
	}
	switch resourceType {
	case "github_repo":
		return validateGithubRepoRef(ref)
	case "local_directory":
		return validateLocalDirectoryRef(ref)
	default:
		return nil, fmt.Errorf("unknown resource_type %q", resourceType)
	}
}

type githubRepoRef struct {
	URL               string `json:"url"`
	DefaultBranchHint string `json:"default_branch_hint,omitempty"`
	Ref               string `json:"ref,omitempty"`
}

func validateGithubRepoRef(ref json.RawMessage) (json.RawMessage, error) {
	var payload githubRepoRef
	if err := json.Unmarshal(ref, &payload); err != nil {
		return nil, fmt.Errorf("invalid github_repo payload: %w", err)
	}
	payload.URL = strings.TrimSpace(payload.URL)
	if payload.URL == "" {
		return nil, errors.New("github_repo: url is required")
	}
	if !isValidGitRepoURL(payload.URL) {
		return nil, errors.New("github_repo: url must be a valid http(s) or ssh git URL")
	}
	payload.DefaultBranchHint = strings.TrimSpace(payload.DefaultBranchHint)
	payload.Ref = strings.TrimSpace(payload.Ref)
	out, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// localDirectoryRef is the JSONB shape stored for resource_type=local_directory.
// It pins a project to an existing directory on a specific user machine, so
// agent tasks run in-place rather than in an isolated git worktree. The
// daemon_id scopes the path to one daemon registration — the same string path
// on a different machine is a different resource. The optional label is a
// human-readable hint used by the UI; the row-level project_resource.label
// column remains the generic column for any resource type.
type localDirectoryRef struct {
	LocalPath string `json:"local_path"`
	DaemonID  string `json:"daemon_id"`
	// RuntimeID is an input-only selector. The handler resolves it in the
	// current workspace, authorizes the caller, and stores only daemon_id.
	RuntimeID string `json:"runtime_id,omitempty"`
	Label     string `json:"label,omitempty"`
}

func validateLocalDirectoryRef(ref json.RawMessage) (json.RawMessage, error) {
	var payload localDirectoryRef
	if err := json.Unmarshal(ref, &payload); err != nil {
		return nil, fmt.Errorf("invalid local_directory payload: %w", err)
	}
	payload.LocalPath = strings.TrimSpace(payload.LocalPath)
	if payload.LocalPath == "" {
		return nil, errors.New("local_directory: local_path is required")
	}
	if !isAbsoluteLocalPath(payload.LocalPath) {
		return nil, errors.New("local_directory: local_path must be an absolute path")
	}
	payload.DaemonID = strings.TrimSpace(payload.DaemonID)
	payload.RuntimeID = strings.TrimSpace(payload.RuntimeID)
	if payload.DaemonID == "" && payload.RuntimeID == "" {
		return nil, errors.New("local_directory: daemon_id or runtime_id is required")
	}
	payload.Label = strings.TrimSpace(payload.Label)
	out, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// localDirectoryRuntimeError is safe to return to callers. Everything else
// from runtime resolution is an internal error and must not disclose details.
type localDirectoryRuntimeError struct {
	status  int
	message string
}

func (e *localDirectoryRuntimeError) Error() string { return e.message }

// canBindLocalDirectoryToDaemon treats daemon_id as a machine identity rather
// than as an attribute of one runtime. A regular member must own every runtime
// registered by that daemon; otherwise they could add a runtime with a peer's
// daemon_id and use it to direct work into the peer's filesystem.
func canBindLocalDirectoryToDaemon(member db.Member, runtimes []db.AgentRuntime, daemonID string) bool {
	if roleAllowed(member.Role, "owner", "admin") {
		return true
	}

	found := false
	for _, runtime := range runtimes {
		if !runtime.DaemonID.Valid || strings.TrimSpace(runtime.DaemonID.String) != daemonID {
			continue
		}
		found = true
		if !runtime.OwnerID.Valid || uuidToString(runtime.OwnerID) != uuidToString(member.UserID) {
			return false
		}
	}
	return found
}

func localDirectoryTargetMatches(existingRef, incomingRef json.RawMessage) bool {
	var existing, incoming localDirectoryRef
	if err := json.Unmarshal(existingRef, &existing); err != nil {
		return false
	}
	if err := json.Unmarshal(incomingRef, &incoming); err != nil {
		return false
	}
	return strings.TrimSpace(existing.LocalPath) == strings.TrimSpace(incoming.LocalPath) &&
		strings.TrimSpace(existing.DaemonID) == strings.TrimSpace(incoming.DaemonID)
}

func canonicalizeLocalDirectoryRef(ref json.RawMessage) (json.RawMessage, error) {
	var payload localDirectoryRef
	if err := json.Unmarshal(ref, &payload); err != nil {
		return nil, err
	}
	payload.RuntimeID = ""
	return json.Marshal(payload)
}

// resolveLocalDirectoryRuntime verifies that a local_directory target refers
// to a local runtime in this workspace that the caller can edit. A browser
// submits runtime_id so the server, rather than the client, chooses the
// canonical daemon_id persisted in resource_ref. daemon_id-only payloads are
// retained for installed desktop/CLI clients, but receive the same ownership
// gate before they can nominate a filesystem path.
func (h *Handler) resolveLocalDirectoryRuntime(
	ctx context.Context,
	workspaceID pgtype.UUID,
	member db.Member,
	ref json.RawMessage,
) (json.RawMessage, error) {
	var payload localDirectoryRef
	if err := json.Unmarshal(ref, &payload); err != nil {
		return nil, fmt.Errorf("decode local_directory ref: %w", err)
	}

	runtimes, err := h.Queries.ListAgentRuntimes(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list local_directory runtimes: %w", err)
	}

	var runtime db.AgentRuntime
	if payload.RuntimeID != "" {
		var runtimeID pgtype.UUID
		if err := runtimeID.Scan(payload.RuntimeID); err != nil {
			return nil, &localDirectoryRuntimeError{
				status:  http.StatusBadRequest,
				message: "local_directory: runtime_id must be a valid UUID",
			}
		}
		for _, candidate := range runtimes {
			if uuidToString(candidate.ID) == uuidToString(runtimeID) {
				runtime = candidate
				break
			}
		}
		if !runtime.ID.Valid {
			return nil, &localDirectoryRuntimeError{
				status:  http.StatusBadRequest,
				message: "local_directory: runtime_id must identify a local runtime in this workspace",
			}
		}
		if runtime.RuntimeMode != "local" || !runtime.DaemonID.Valid || strings.TrimSpace(runtime.DaemonID.String) == "" {
			return nil, &localDirectoryRuntimeError{
				status:  http.StatusBadRequest,
				message: "local_directory: runtime_id must identify a local runtime in this workspace",
			}
		}
	} else {
		for _, candidate := range runtimes {
			if candidate.RuntimeMode != "local" || !candidate.DaemonID.Valid || strings.TrimSpace(candidate.DaemonID.String) != payload.DaemonID {
				continue
			}
			runtime = candidate
			break
		}
		if !runtime.ID.Valid {
			return nil, &localDirectoryRuntimeError{
				status:  http.StatusBadRequest,
				message: "local_directory: daemon_id must identify a local runtime in this workspace",
			}
		}
	}

	if !canEditRuntime(member, runtime) || !canBindLocalDirectoryToDaemon(member, runtimes, strings.TrimSpace(runtime.DaemonID.String)) {
		return nil, &localDirectoryRuntimeError{
			status:  http.StatusForbidden,
			message: "local_directory: only the runtime owner or a workspace admin can attach this directory",
		}
	}

	payload.DaemonID = strings.TrimSpace(runtime.DaemonID.String)
	payload.RuntimeID = ""
	canonical, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode local_directory ref: %w", err)
	}
	return canonical, nil
}

func writeLocalDirectoryRuntimeError(w http.ResponseWriter, err error, prefix string) {
	var clientErr *localDirectoryRuntimeError
	if errors.As(err, &clientErr) {
		writeError(w, clientErr.status, prefix+clientErr.message)
		return
	}
	writeError(w, http.StatusInternalServerError, "failed to resolve local directory runtime")
}

// isAbsoluteLocalPath checks the path looks absolute on either POSIX or
// Windows daemons. The server can't know which OS the daemon runs on, so we
// accept the union: a leading "/" (POSIX), a UNC prefix "\\", or a drive
// letter like "C:\" or "C:/". The daemon still verifies existence at run
// time — this is a typo guard, not a filesystem check.
func isAbsoluteLocalPath(s string) bool {
	if s == "" {
		return false
	}
	if s[0] == '/' {
		return true
	}
	if strings.HasPrefix(s, `\\`) {
		return true
	}
	if len(s) >= 3 && isDriveLetter(s[0]) && s[1] == ':' && (s[2] == '\\' || s[2] == '/') {
		return true
	}
	return false
}

func isDriveLetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// isValidGitRepoURL accepts the three forms a user can paste from GitHub's
// "Code" menu: https://, ssh:// (with explicit scheme), and the scp-like
// shorthand `git@host:owner/repo.git`. The check is intentionally lax — we are
// guarding against pasted garbage like "not-a-url", not enforcing a strict
// grammar — because the actual fetch happens client-side via `git clone` and
// the user gets a clearer error from git than from us.
func isValidGitRepoURL(s string) bool {
	if u, err := url.Parse(s); err == nil && u.Host != "" {
		switch u.Scheme {
		case "http", "https", "ssh", "git":
			return true
		}
	}
	// scp-like ssh shorthand: [user@]host:path with a non-empty host and path,
	// and no spaces. Reject anything that looks like a URL with a scheme
	// (those should go through url.Parse above).
	if strings.Contains(s, " ") || strings.Contains(s, "://") {
		return false
	}
	colon := strings.Index(s, ":")
	if colon <= 0 || colon == len(s)-1 {
		return false
	}
	// In scp-like ssh shorthand `[user@]host:path`, `@` is only meaningful
	// as a user separator before the first ':'. If '@' appears at or after
	// the colon it is not the user separator — reject as malformed rather
	// than guess (and avoid a slice-bounds panic from blindly slicing).
	at := strings.Index(s, "@")
	if at >= colon {
		return false
	}
	hostStart := 0
	if at >= 0 {
		hostStart = at + 1
	}
	host := s[hostStart:colon]
	path := s[colon+1:]
	if host == "" || path == "" {
		return false
	}
	return true
}

// loadProjectForResource resolves the project, enforces workspace ownership,
// and returns its DB row. Used by all project_resource handlers.
func (h *Handler) loadProjectForResource(w http.ResponseWriter, r *http.Request, projectIDParam string) (db.Project, bool) {
	projectUUID, ok := parseUUIDOrBadRequest(w, projectIDParam, "project id")
	if !ok {
		return db.Project{}, false
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return db.Project{}, false
	}
	project, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
		ID: projectUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return db.Project{}, false
	}
	return project, true
}

// ListProjectResources returns the resources attached to a project.
func (h *Handler) ListProjectResources(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	resources, err := h.Queries.ListProjectResources(r.Context(), project.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project resources")
		return
	}
	resp := make([]ProjectResourceResponse, len(resources))
	for i, res := range resources {
		resp[i] = projectResourceToResponse(res)
	}
	writeJSON(w, http.StatusOK, map[string]any{"resources": resp, "total": len(resp)})
}

// CreateProjectResource attaches a new resource to a project.
func (h *Handler) CreateProjectResource(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req CreateProjectResourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.ResourceType = strings.TrimSpace(req.ResourceType)
	if req.ResourceType == "" {
		writeError(w, http.StatusBadRequest, "resource_type is required")
		return
	}
	normalizedRef, err := validateAndNormalizeResourceRef(req.ResourceType, req.ResourceRef)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ResourceType == "local_directory" {
		member, ok := h.workspaceMember(w, r, uuidToString(project.WorkspaceID))
		if !ok {
			return
		}
		normalizedRef, err = h.resolveLocalDirectoryRuntime(
			r.Context(), project.WorkspaceID, member, normalizedRef,
		)
		if err != nil {
			writeLocalDirectoryRuntimeError(w, err, "")
			return
		}
	}

	if conflict, err := h.findLocalDirectoryConflict(r.Context(), project.ID, req.ResourceType, normalizedRef, pgtype.UUID{}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check existing resources")
		return
	} else if conflict {
		writeError(w, http.StatusConflict, "this daemon already has a local_directory attached to the project; remove it before adding another")
		return
	}

	var label pgtype.Text
	if req.Label != nil && strings.TrimSpace(*req.Label) != "" {
		label = pgtype.Text{String: strings.TrimSpace(*req.Label), Valid: true}
	}
	var position int32
	if req.Position != nil {
		position = *req.Position
	} else {
		// Append after existing resources.
		count, _ := h.Queries.CountProjectResources(r.Context(), project.ID)
		position = int32(count)
	}

	creator, _ := h.parseUserUUIDOrZero(userID)
	resource, err := h.Queries.CreateProjectResource(r.Context(), db.CreateProjectResourceParams{
		ProjectID:    project.ID,
		WorkspaceID:  project.WorkspaceID,
		ResourceType: req.ResourceType,
		ResourceRef:  normalizedRef,
		Label:        label,
		Position:     position,
		CreatedBy:    creator,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "this resource is already attached to the project")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create project resource")
		return
	}

	resp := projectResourceToResponse(resource)
	h.publish(
		protocol.EventProjectResourceCreated,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{"resource": resp, "project_id": uuidToString(project.ID)},
	)
	writeJSON(w, http.StatusCreated, resp)
}

// UpdateProjectResource edits an existing resource's ref/label/position.
// resource_type is immutable — re-pointing a resource at a different type is
// almost always a different conceptual entity, so the caller should delete and
// re-add instead. Omitted fields keep their current value, including the
// `label` JSON null vs. missing distinction (missing = keep, explicit "" =
// clear).
func (h *Handler) UpdateProjectResource(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	resourceUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "resourceId"), "resource id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	existing, err := h.Queries.GetProjectResourceInWorkspace(r.Context(), db.GetProjectResourceInWorkspaceParams{
		ID: resourceUUID, WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "project resource not found")
		return
	}
	if uuidToString(existing.ProjectID) != uuidToString(project.ID) {
		writeError(w, http.StatusNotFound, "project resource not found")
		return
	}

	// Decode into a raw map first so we can tell "field omitted" from
	// "field present with zero value" — the label clear case in particular
	// relies on this distinction.
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	nextRef := json.RawMessage(existing.ResourceRef)
	if rawRef, ok := raw["resource_ref"]; ok {
		normalized, err := validateAndNormalizeResourceRef(existing.ResourceType, rawRef)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if existing.ResourceType == "local_directory" {
			if localDirectoryTargetMatches(existing.ResourceRef, normalized) {
				normalized, err = canonicalizeLocalDirectoryRef(normalized)
				if err != nil {
					writeError(w, http.StatusBadRequest, "invalid local_directory payload")
					return
				}
			} else {
				member, ok := h.workspaceMember(w, r, uuidToString(project.WorkspaceID))
				if !ok {
					return
				}
				normalized, err = h.resolveLocalDirectoryRuntime(
					r.Context(), project.WorkspaceID, member, normalized,
				)
				if err != nil {
					writeLocalDirectoryRuntimeError(w, err, "")
					return
				}
			}
		}
		nextRef = normalized
	}

	if conflict, err := h.findLocalDirectoryConflict(r.Context(), project.ID, existing.ResourceType, nextRef, existing.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check existing resources")
		return
	} else if conflict {
		writeError(w, http.StatusConflict, "another local_directory on this daemon is already attached to the project")
		return
	}

	nextLabel := existing.Label
	if rawLabel, ok := raw["label"]; ok {
		var labelStr *string
		if err := json.Unmarshal(rawLabel, &labelStr); err != nil {
			writeError(w, http.StatusBadRequest, "label must be a string or null")
			return
		}
		if labelStr == nil || strings.TrimSpace(*labelStr) == "" {
			nextLabel = pgtype.Text{}
		} else {
			nextLabel = pgtype.Text{String: strings.TrimSpace(*labelStr), Valid: true}
		}
	}

	nextPosition := existing.Position
	if rawPos, ok := raw["position"]; ok {
		var pos *int32
		if err := json.Unmarshal(rawPos, &pos); err != nil {
			writeError(w, http.StatusBadRequest, "position must be an integer")
			return
		}
		if pos != nil {
			nextPosition = *pos
		}
	}

	updated, err := h.Queries.UpdateProjectResource(r.Context(), db.UpdateProjectResourceParams{
		ID:          existing.ID,
		ResourceRef: nextRef,
		Label:       nextLabel,
		Position:    nextPosition,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "this resource is already attached to the project")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update project resource")
		return
	}

	resp := projectResourceToResponse(updated)
	h.publish(
		protocol.EventProjectResourceUpdated,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{"resource": resp, "project_id": uuidToString(project.ID)},
	)
	writeJSON(w, http.StatusOK, resp)
}

// findLocalDirectoryConflict enforces "at most one local_directory resource
// per (project, daemon)". The daemon picks the first matching daemon_id row
// out of a task's resources (findLocalDirectoryAssignment), so letting a
// project carry two rows for the same daemon would mean the agent silently
// writes into whichever happens to come back first — a safety hazard for a
// feature that operates directly on the user's real working directory.
//
// The DB-level UNIQUE(project_id, resource_type, resource_ref) constraint
// alone is not enough here: it only fires on full ref-JSON equality, so a
// different local_path or even a typoed label on the same daemon would slip
// through. We do the daemon-scoped check here in application code instead.
//
// `excludeID` lets the update path ignore the row being edited.
func (h *Handler) findLocalDirectoryConflict(ctx context.Context, projectID pgtype.UUID, resourceType string, normalizedRef json.RawMessage, excludeID pgtype.UUID) (bool, error) {
	if resourceType != "local_directory" {
		return false, nil
	}
	var incoming localDirectoryRef
	if err := json.Unmarshal(normalizedRef, &incoming); err != nil {
		return false, err
	}
	rows, err := h.Queries.ListProjectResources(ctx, projectID)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		if row.ResourceType != "local_directory" {
			continue
		}
		if excludeID.Valid && uuidToString(row.ID) == uuidToString(excludeID) {
			continue
		}
		var existing localDirectoryRef
		if err := json.Unmarshal(row.ResourceRef, &existing); err != nil {
			continue
		}
		// Daemon-scoped uniqueness: one local_directory per daemon per
		// project. Different daemons can each carry one row (one per
		// user device); the daemon-side resolver routes each daemon to
		// its own assignment by daemon_id.
		if existing.DaemonID == incoming.DaemonID {
			return true, nil
		}
	}
	return false, nil
}

// DeleteProjectResource removes a resource from a project.
func (h *Handler) DeleteProjectResource(w http.ResponseWriter, r *http.Request) {
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	resourceUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "resourceId"), "resource id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	resource, err := h.Queries.GetProjectResourceInWorkspace(r.Context(), db.GetProjectResourceInWorkspaceParams{
		ID: resourceUUID, WorkspaceID: project.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "project resource not found")
		return
	}
	if uuidToString(resource.ProjectID) != uuidToString(project.ID) {
		writeError(w, http.StatusNotFound, "project resource not found")
		return
	}
	if err := h.Queries.DeleteProjectResource(r.Context(), resource.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete project resource")
		return
	}
	h.publish(
		protocol.EventProjectResourceDeleted,
		uuidToString(project.WorkspaceID),
		"member",
		userID,
		map[string]any{
			"project_id":  uuidToString(project.ID),
			"resource_id": uuidToString(resource.ID),
		},
	)
	w.WriteHeader(http.StatusNoContent)
}

// parseUserUUIDOrZero converts a user ID string to a pgtype.UUID, returning a
// zero value on any error so the caller can store NULL for created_by when the
// authenticated principal is not a workspace member (e.g. internal-server use).
func (h *Handler) parseUserUUIDOrZero(userID string) (pgtype.UUID, bool) {
	if userID == "" {
		return pgtype.UUID{}, false
	}
	u, err := parseUUIDLoose(userID)
	if err != nil {
		return pgtype.UUID{}, false
	}
	return u, true
}

// parseUUIDLoose mirrors util.ParseUUID but lives here to avoid pulling util
// into a tiny one-off helper. Keep the body minimal.
func parseUUIDLoose(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return pgtype.UUID{}, err
	}
	return u, nil
}

// listProjectResourcesForProject is a small helper used by the daemon claim
// handler to attach project resources to outgoing tasks.
func (h *Handler) listProjectResourcesForProject(ctx context.Context, projectID pgtype.UUID) []db.ProjectResource {
	if !projectID.Valid {
		return nil
	}
	rows, err := h.Queries.ListProjectResources(ctx, projectID)
	if err != nil {
		return nil
	}
	return rows
}
