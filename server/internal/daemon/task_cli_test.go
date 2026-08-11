package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/taskcli"
)

func TestTaskCLIHandlerUsesDaemonOwnedToken(t *testing.T) {
	workDir := t.TempDir()
	d := &Daemon{}
	capability, release, err := d.registerTaskCLI(taskCLIRegistration{
		ParentCtx:   context.Background(),
		Token:       "mat_task_token",
		ServerURL:   "https://task.example",
		WorkspaceID: "workspace-1",
		AgentID:     "agent-1",
		AgentName:   "Agent One",
		TaskID:      "task-1",
		WorkDir:     workDir,
		Env: map[string]string{
			"MULTICA_DAEMON_PORT":         "27182",
			"MULTICA_TASK_CLI_CAPABILITY": "must-not-reach-broker-child",
			"MULTICA_TOKEN":               "must-not-reach-broker-child",
		},
	})
	if err != nil {
		t.Fatalf("registerTaskCLI: %v", err)
	}
	defer release()

	var gotArgs []string
	d.taskCLICommandRunner = func(_ context.Context, _ string, gotWorkDir string, env, args []string) taskcli.Response {
		if gotWorkDir != workDir {
			t.Errorf("workdir = %q, want %q", gotWorkDir, workDir)
		}
		gotArgs = append([]string(nil), args...)
		values := taskCLIEnvironmentValues(env)
		if got := values["MULTICA_TOKEN"]; got != "mat_task_token" {
			t.Errorf("broker token = %q, want task token", got)
		}
		if got := values[taskcli.CapabilityEnv]; got != "" {
			t.Errorf("broker child received capability %q", got)
		}
		if got := values[taskcli.BrokerExecEnv]; got != "1" {
			t.Errorf("broker bypass = %q, want 1", got)
		}
		if got := values["MULTICA_DAEMON_PORT"]; got != "27182" {
			t.Errorf("daemon port = %q, want 27182", got)
		}
		return taskcli.Response{ExitCode: 0, Stdout: "{\"ok\":true}\n"}
	}

	body, err := json.Marshal(taskcli.Request{Capability: capability, Args: []string{"issue", "get", "issue-1", "--output", "json"}})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	rec := httptest.NewRecorder()
	d.taskCLIHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, taskcli.BrokerPath, bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if got, want := gotArgs, []string{"issue", "get", "issue-1", "--output", "json"}; !sameTaskCLIArgs(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
	var response taskcli.Response
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Stdout != "{\"ok\":true}\n" || response.ExitCode != 0 {
		t.Fatalf("response = %#v", response)
	}
}

func TestTaskCLIHandlerRejectsExpiredCapabilityAndEscapingFile(t *testing.T) {
	workDir := t.TempDir()
	d := &Daemon{
		taskCLICapabilities: map[string]*taskCLICapability{
			"live-capability": {
				ctx:     context.Background(),
				token:   "mat_task_token",
				workDir: workDir,
				binary:  "multica",
			},
		},
	}
	called := false
	d.taskCLICommandRunner = func(context.Context, string, string, []string, []string) taskcli.Response {
		called = true
		return taskcli.Response{}
	}

	request := func(capability string, args []string) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(taskcli.Request{Capability: capability, Args: args})
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		rec := httptest.NewRecorder()
		d.taskCLIHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, taskcli.BrokerPath, bytes.NewReader(body)))
		return rec
	}

	if rec := request("expired-capability", []string{"issue", "get", "issue-1"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired capability status = %d, want 401", rec.Code)
	}

	externalFile := filepath.Join(t.TempDir(), "reply.md")
	if err := os.WriteFile(externalFile, []byte("outside task workdir"), 0o600); err != nil {
		t.Fatalf("write external file: %v", err)
	}
	if rec := request("live-capability", []string{"issue", "comment", "add", "issue-1", "--content-file", externalFile}); rec.Code != http.StatusBadRequest {
		t.Fatalf("escaping file status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if rec := request("live-capability", []string{"agent", "create", "--mcp-config-file", externalFile}); rec.Code != http.StatusBadRequest {
		t.Fatalf("escaping MCP file status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if rec := request("live-capability", []string{"attachment", "upload", externalFile}); rec.Code != http.StatusBadRequest {
		t.Fatalf("escaping upload path status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if rec := request("live-capability", []string{"attachment", "download", "attachment-1", "-o", filepath.Dir(externalFile)}); rec.Code != http.StatusBadRequest {
		t.Fatalf("escaping output directory status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if rec := request("live-capability", []string{"runtime", "update", "runtime-1", "--target-version", "v1.2.3"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("runtime mutation status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if called {
		t.Fatal("rejected task CLI request reached command runner")
	}
}

func TestTaskCLIProcessEnvKeepsCapabilityOutOfBrokerChild(t *testing.T) {
	env := taskCLIProcessEnv(&taskCLICapability{
		token:       "mat_task_token",
		serverURL:   "https://task.example",
		workspaceID: "workspace-1",
		agentID:     "agent-1",
		agentName:   "Agent One",
		taskID:      "task-1",
		env: map[string]string{
			"MULTICA_DAEMON_PORT":         "27182",
			"MULTICA_TASK_CLI_CAPABILITY": "capability",
			"MULTICA_TOKEN":               "wrong-token",
		},
	})
	values := taskCLIEnvironmentValues(env)
	if got := values["MULTICA_TOKEN"]; got != "mat_task_token" {
		t.Fatalf("MULTICA_TOKEN = %q, want daemon-held task token", got)
	}
	for _, forbidden := range []string{taskcli.CapabilityEnv} {
		if got := values[forbidden]; got != "" {
			t.Errorf("broker child inherited %s=%q", forbidden, got)
		}
	}
	if got := values[taskcli.BrokerExecEnv]; got != "1" {
		t.Fatalf("%s = %q, want 1", taskcli.BrokerExecEnv, got)
	}
}

func TestCloneTaskCLIEnvRetainsOnlyTaskContext(t *testing.T) {
	cloned := cloneTaskCLIEnv(map[string]string{
		"MULTICA_DAEMON_PORT":          "27182",
		"MULTICA_QUICK_CREATE_TASK_ID": "task-1",
		"MULTICA_TOKEN":                "mat_task_token",
		"MULTICA_TASK_CLI_CAPABILITY":  "capability",
		"CUSTOM_SECRET":                "do-not-retain",
	})
	for _, want := range []string{"MULTICA_DAEMON_PORT", "MULTICA_QUICK_CREATE_TASK_ID"} {
		if cloned[want] == "" {
			t.Errorf("clone missing %s", want)
		}
	}
	for _, forbidden := range []string{"MULTICA_TOKEN", taskcli.CapabilityEnv, "CUSTOM_SECRET"} {
		if cloned[forbidden] != "" {
			t.Errorf("clone retained %s", forbidden)
		}
	}
}

func TestTaskCLITimeoutClampsRequestedValue(t *testing.T) {
	if got := taskCLITimeout([]string{"issue", "get", "issue-1"}, int(maxTaskCLITimeout/time.Millisecond)+1); got != maxTaskCLITimeout {
		t.Fatalf("large requested timeout = %s, want %s", got, maxTaskCLITimeout)
	}
	if got := taskCLITimeout([]string{"repo", "checkout", "https://example.test/repo.git"}, 0); got != longTaskCLITimeout {
		t.Fatalf("repo default timeout = %s, want %s", got, longTaskCLITimeout)
	}
}

func taskCLIEnvironmentValues(env []string) map[string]string {
	values := make(map[string]string, len(env))
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}

func sameTaskCLIArgs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
