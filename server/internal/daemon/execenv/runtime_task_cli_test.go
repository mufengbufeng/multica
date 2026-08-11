package execenv

import (
	"strings"
	"testing"
)

func TestRuntimeBriefExplainsTaskCLIChannelForEveryTaskKind(t *testing.T) {
	t.Parallel()

	contexts := []TaskContextForEnv{
		{IssueID: "issue-1"},
		{ChatSessionID: "chat-1"},
		{AutopilotRunID: "run-1"},
		{QuickCreatePrompt: "create an issue"},
	}
	for _, ctx := range contexts {
		brief := buildMetaSkillContent("codex", ctx)
		for _, want := range []string{
			"daemon's task CLI channel automatically",
			"not a Node/REPL/browser bridge",
			"task CLI channel is unavailable",
			"do not retry through another tool",
			".multica/daemon_task_context.json",
		} {
			if !strings.Contains(brief, want) {
				t.Errorf("task context %#v: brief missing %q", ctx, want)
			}
		}
	}
}
