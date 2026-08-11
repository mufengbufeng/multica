package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/taskcli"
)

func TestProxyTaskCLIRequestForwardsCommandAndOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		var request taskcli.Request
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if request.Capability != "capability-1" {
			t.Errorf("capability = %q", request.Capability)
		}
		if !sameTaskCLIProxyArgs(request.Args, []string{"issue", "get", "issue-1", "--output", "json"}) {
			t.Errorf("args = %#v", request.Args)
		}
		_ = json.NewEncoder(w).Encode(taskcli.Response{
			ExitCode: 0,
			Stdout:   "{\"id\":\"issue-1\"}\n",
			Stderr:   "broker notice",
		})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := proxyTaskCLIRequest(server.Client(), server.URL, "capability-1", []string{"issue", "get", "issue-1", "--output", "json"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr=%q", code, stderr.String())
	}
	if got := stdout.String(); got != "{\"id\":\"issue-1\"}\n" {
		t.Fatalf("stdout = %q", got)
	}
	if got := stderr.String(); got != "broker notice\n" {
		t.Fatalf("stderr = %q", got)
	}
}

func TestProxyTaskCLIRequestReturnsBrokerFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(taskcli.Response{ErrorCode: "invalid_capability", Stderr: "task CLI capability is no longer valid"})
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := proxyTaskCLIRequest(server.Client(), server.URL, "expired", []string{"issue", "get", "issue-1"}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if got := stderr.String(); !strings.Contains(got, "capability is no longer valid") {
		t.Fatalf("stderr = %q, want broker rejection", got)
	}
}

func TestProxyTaskCLIReportsUnavailableChannelWithoutFallback(t *testing.T) {
	t.Setenv(taskcli.CapabilityEnv, "capability-1")
	t.Setenv("MULTICA_DAEMON_PORT", "")
	var stdout, stderr bytes.Buffer
	handled, code := proxyTaskCLI([]string{"issue", "get", "issue-1"}, &stdout, &stderr)
	if !handled {
		t.Fatal("task CLI command was not handled")
	}
	if code != taskCLIProxyUnavailableExitCode {
		t.Fatalf("exit code = %d, want %d", code, taskCLIProxyUnavailableExitCode)
	}
	if got := stderr.String(); !strings.Contains(got, "task CLI channel is unavailable") {
		t.Fatalf("stderr = %q", got)
	}
}

func TestTaskCLIHelpOnlyBypassesBroker(t *testing.T) {
	for _, args := range [][]string{
		nil,
		{"help", "issue"},
		{"issue", "get", "issue-1", "--help"},
		{"version"},
	} {
		if !taskCLIHelpOnly(args) {
			t.Errorf("taskCLIHelpOnly(%#v) = false, want true", args)
		}
	}
	if taskCLIHelpOnly([]string{"issue", "get", "issue-1"}) {
		t.Fatal("normal issue command bypassed broker")
	}
}

func sameTaskCLIProxyArgs(got, want []string) bool {
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
