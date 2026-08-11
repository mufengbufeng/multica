package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/taskcli"
)

const (
	taskCLIProxyUnavailableExitCode = 75
	taskCLIProxyResponseLimit       = 3 << 20
	// Keep the client deadline slightly above the broker's maximum command
	// timeout so a response can still cross the local loopback connection.
	taskCLIProxyHTTPTimeout = 10*time.Minute + 10*time.Second
)

const taskCLIChannelUnavailableMessage = "task CLI channel is unavailable in this process; run `multica ...` from the task's native shell and do not retry through an isolated process or stored credentials"

// proxyTaskCLI forwards normal platform CLI commands through the daemon when a
// task capability is present. The agent keeps the familiar `multica ...`
// interface while the daemon retains the raw task token.
func proxyTaskCLI(args []string, stdout, stderr io.Writer) (bool, int) {
	if os.Getenv(taskcli.BrokerExecEnv) != "" || taskCLIHelpOnly(args) {
		return false, 0
	}
	capability := strings.TrimSpace(os.Getenv(taskcli.CapabilityEnv))
	if capability == "" {
		return false, 0
	}

	port, err := taskCLIDaemonPort(os.Getenv("MULTICA_DAEMON_PORT"))
	if err != nil {
		fmt.Fprintln(stderr, taskCLIChannelUnavailableMessage)
		return true, taskCLIProxyUnavailableExitCode
	}
	endpoint := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + taskcli.BrokerPath
	client := &http.Client{Timeout: taskCLIProxyHTTPTimeout}
	return true, proxyTaskCLIRequest(client, endpoint, capability, args, stdout, stderr)
}

func taskCLIDaemonPort(value string) (int, error) {
	port, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid daemon port")
	}
	return port, nil
}

func taskCLIHelpOnly(args []string) bool {
	if len(args) == 0 {
		return true
	}
	for _, arg := range args {
		switch arg {
		case "-h", "--help", "--version":
			return true
		}
	}
	switch args[0] {
	case "help", "version", "completion":
		return true
	default:
		return false
	}
}

func proxyTaskCLIRequest(client *http.Client, endpoint, capability string, args []string, stdout, stderr io.Writer) int {
	body, err := json.Marshal(taskcli.Request{Capability: capability, Args: args})
	if err != nil {
		fmt.Fprintln(stderr, "task CLI request could not be encoded")
		return 1
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(stderr, taskCLIChannelUnavailableMessage)
		return taskCLIProxyUnavailableExitCode
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintln(stderr, taskCLIChannelUnavailableMessage)
		return taskCLIProxyUnavailableExitCode
	}
	defer resp.Body.Close()

	var result taskcli.Response
	if err := json.NewDecoder(io.LimitReader(resp.Body, taskCLIProxyResponseLimit)).Decode(&result); err != nil {
		fmt.Fprintln(stderr, taskCLIChannelUnavailableMessage)
		return taskCLIProxyUnavailableExitCode
	}
	if result.Stdout != "" {
		_, _ = io.WriteString(stdout, result.Stdout)
	}
	if result.Stderr != "" {
		_, _ = io.WriteString(stderr, result.Stderr)
		if !strings.HasSuffix(result.Stderr, "\n") {
			_, _ = io.WriteString(stderr, "\n")
		}
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if result.Stderr == "" {
			fmt.Fprintln(stderr, taskCLIChannelUnavailableMessage)
		}
		if result.ExitCode != 0 {
			return result.ExitCode
		}
		return 1
	}
	if result.ExitCode != 0 {
		return result.ExitCode
	}
	return 0
}
