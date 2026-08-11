// Package taskcli defines the private protocol between a task-scoped CLI
// proxy and the local Multica daemon.
package taskcli

const (
	// CapabilityEnv is deliberately not named TOKEN. It grants access only to
	// the task's local CLI broker; the daemon retains the raw task auth token.
	CapabilityEnv = "MULTICA_TASK_CLI_CAPABILITY"

	// BrokerExecEnv prevents the daemon-owned CLI child from forwarding its
	// invocation back to the broker.
	BrokerExecEnv = "MULTICA_TASK_CLI_BROKER_EXEC"

	BrokerPath = "/task-cli/run"
)

// Request is sent by the task CLI proxy to the local daemon. Args never
// include the multica executable itself.
type Request struct {
	Capability string   `json:"capability"`
	Args       []string `json:"args"`
	TimeoutMS  int      `json:"timeout_ms,omitempty"`
}

// Response preserves CLI stdout/stderr while making broker failures machine
// readable to the caller.
type Response struct {
	ExitCode        int    `json:"exit_code"`
	Stdout          string `json:"stdout,omitempty"`
	Stderr          string `json:"stderr,omitempty"`
	ErrorCode       string `json:"error_code,omitempty"`
	OutputTruncated bool   `json:"output_truncated,omitempty"`
}
