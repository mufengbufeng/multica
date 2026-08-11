package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/taskcli"
)

const (
	defaultTaskCLITimeout = 30 * time.Second
	longTaskCLITimeout    = 5 * time.Minute
	maxTaskCLITimeout     = 10 * time.Minute
	taskCLIOutputLimit    = 1 << 20
)

type taskCLICapability struct {
	ctx         context.Context
	cancel      context.CancelFunc
	token       string
	serverURL   string
	workspaceID string
	agentID     string
	agentName   string
	taskID      string
	workDir     string
	env         map[string]string
	binary      string
}

type taskCLICommandRunner func(context.Context, string, string, []string, []string) taskcli.Response

type taskCLIRegistration struct {
	ParentCtx   context.Context
	Token       string
	ServerURL   string
	WorkspaceID string
	AgentID     string
	AgentName   string
	TaskID      string
	WorkDir     string
	Env         map[string]string
}

func (d *Daemon) registerTaskCLI(reg taskCLIRegistration) (string, func(), error) {
	if strings.TrimSpace(reg.Token) == "" || !strings.HasPrefix(reg.Token, "mat_") {
		return "", nil, errors.New("task CLI broker requires a task-scoped mat_ token")
	}
	if strings.TrimSpace(reg.WorkDir) == "" {
		return "", nil, errors.New("task CLI broker requires a workdir")
	}
	binary, err := resolveSelfExecutable()
	if err != nil {
		return "", nil, fmt.Errorf("resolve task CLI binary: %w", err)
	}
	capability, err := newTaskCLICapability()
	if err != nil {
		return "", nil, err
	}
	parent := reg.ParentCtx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	record := &taskCLICapability{
		ctx:         ctx,
		cancel:      cancel,
		token:       reg.Token,
		serverURL:   reg.ServerURL,
		workspaceID: reg.WorkspaceID,
		agentID:     reg.AgentID,
		agentName:   reg.AgentName,
		taskID:      reg.TaskID,
		workDir:     reg.WorkDir,
		env:         cloneTaskCLIEnv(reg.Env),
		binary:      binary,
	}

	d.taskCLIMu.Lock()
	if d.taskCLICapabilities == nil {
		d.taskCLICapabilities = make(map[string]*taskCLICapability)
	}
	d.taskCLICapabilities[capability] = record
	d.taskCLIMu.Unlock()

	var released bool
	release := func() {
		d.taskCLIMu.Lock()
		if !released {
			released = true
			delete(d.taskCLICapabilities, capability)
			record.cancel()
		}
		d.taskCLIMu.Unlock()
	}
	return capability, release, nil
}

func newTaskCLICapability() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate task CLI capability: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func cloneTaskCLIEnv(source map[string]string) map[string]string {
	copy := make(map[string]string, len(source))
	for key, value := range source {
		if !strings.HasPrefix(strings.ToUpper(key), "MULTICA_") || taskCLIReservedEnvKey(key) {
			continue
		}
		copy[key] = value
	}
	return copy
}

func taskCLIReservedEnvKey(key string) bool {
	for _, reserved := range []string{
		"MULTICA_TOKEN",
		"MULTICA_SERVER_URL",
		"MULTICA_WORKSPACE_ID",
		"MULTICA_AGENT_ID",
		"MULTICA_AGENT_NAME",
		"MULTICA_TASK_ID",
		taskcli.CapabilityEnv,
		taskcli.BrokerExecEnv,
	} {
		if strings.EqualFold(key, reserved) {
			return true
		}
	}
	return false
}

func (d *Daemon) taskCLIHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		defer r.Body.Close()

		var req taskcli.Request
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			writeTaskCLIResponse(w, http.StatusBadRequest, taskcli.Response{ErrorCode: "invalid_request", Stderr: "task CLI request is invalid"})
			return
		}
		if strings.TrimSpace(req.Capability) == "" {
			writeTaskCLIResponse(w, http.StatusUnauthorized, taskcli.Response{ErrorCode: "invalid_capability", Stderr: "task CLI capability is required"})
			return
		}

		d.taskCLIMu.Lock()
		record := d.taskCLICapabilities[req.Capability]
		d.taskCLIMu.Unlock()
		if record == nil {
			writeTaskCLIResponse(w, http.StatusUnauthorized, taskcli.Response{ErrorCode: "invalid_capability", Stderr: "task CLI capability is no longer valid"})
			return
		}
		if err := validateTaskCLIArgs(req.Args, record.workDir); err != nil {
			writeTaskCLIResponse(w, http.StatusBadRequest, taskcli.Response{ErrorCode: "forbidden_command", Stderr: err.Error()})
			return
		}

		timeout := taskCLITimeout(req.Args, req.TimeoutMS)
		ctx, cancel := context.WithTimeout(record.ctx, timeout)
		defer cancel()
		response := d.runTaskCLICommand(ctx, record, req.Args)
		writeTaskCLIResponse(w, http.StatusOK, response)
	}
}

func writeTaskCLIResponse(w http.ResponseWriter, status int, response taskcli.Response) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}

func (d *Daemon) runTaskCLICommand(ctx context.Context, record *taskCLICapability, args []string) taskcli.Response {
	env := taskCLIProcessEnv(record)
	if d.taskCLICommandRunner != nil {
		return d.taskCLICommandRunner(ctx, record.binary, record.workDir, env, args)
	}
	return defaultTaskCLICommandRunner(ctx, record.binary, record.workDir, env, args)
}

func defaultTaskCLICommandRunner(ctx context.Context, binary, workDir string, env, args []string) taskcli.Response {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = workDir
	cmd.Env = env
	var stdout, stderr boundedTaskCLIOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	response := taskcli.Response{
		ExitCode:        0,
		Stdout:          redactTaskCLIOutput(stdout.String()),
		Stderr:          redactTaskCLIOutput(stderr.String()),
		OutputTruncated: stdout.truncated || stderr.truncated,
	}
	if response.OutputTruncated {
		response.ExitCode = 1
		response.ErrorCode = "output_truncated"
		if response.Stderr == "" {
			response.Stderr = "task CLI output exceeded the broker limit"
		}
	}
	if err == nil {
		return response
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		response.ExitCode = 124
		response.ErrorCode = "task_cli_timeout"
		if response.Stderr == "" {
			response.Stderr = "task CLI command timed out"
		}
		return response
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		response.ExitCode = exitErr.ExitCode()
		return response
	}
	response.ExitCode = 1
	response.ErrorCode = "task_cli_execution_failed"
	if response.Stderr == "" {
		response.Stderr = "task CLI command could not be started"
	}
	return response
}

func taskCLIProcessEnv(record *taskCLICapability) []string {
	overrides := map[string]string{
		"MULTICA_TOKEN":        record.token,
		"MULTICA_SERVER_URL":   record.serverURL,
		"MULTICA_WORKSPACE_ID": record.workspaceID,
		"MULTICA_AGENT_ID":     record.agentID,
		"MULTICA_AGENT_NAME":   record.agentName,
		"MULTICA_TASK_ID":      record.taskID,
		taskcli.BrokerExecEnv:  "1",
	}
	for key, value := range record.env {
		if strings.HasPrefix(strings.ToUpper(key), "MULTICA_") && !taskCLIReservedEnvKey(key) {
			overrides[key] = value
		}
	}
	return mergeTaskCLIEnv(os.Environ(), overrides)
}

func mergeTaskCLIEnv(base []string, overrides map[string]string) []string {
	result := make([]string, 0, len(base)+len(overrides))
	for _, item := range base {
		key, _, found := strings.Cut(item, "=")
		if !found {
			continue
		}
		if strings.HasPrefix(strings.ToUpper(key), "MULTICA_") {
			continue
		}
		result = append(result, item)
	}
	for key, value := range overrides {
		result = append(result, key+"="+value)
	}
	return result
}

func taskCLITimeout(args []string, requestedMS int) time.Duration {
	if requestedMS > 0 {
		if requestedMS >= int(maxTaskCLITimeout/time.Millisecond) {
			return maxTaskCLITimeout
		}
		requested := time.Duration(requestedMS) * time.Millisecond
		return requested
	}
	if len(args) > 0 && (args[0] == "repo" || args[0] == "attachment") {
		return longTaskCLITimeout
	}
	return defaultTaskCLITimeout
}

var taskCLIRedactionPattern = regexp.MustCompile(`\bmat_[A-Za-z0-9._-]+`)

func redactTaskCLIOutput(value string) string {
	return taskCLIRedactionPattern.ReplaceAllString(value, "mat_[REDACTED]")
}

type boundedTaskCLIOutput struct {
	bytes.Buffer
	truncated bool
}

func (b *boundedTaskCLIOutput) Write(data []byte) (int, error) {
	remaining := taskCLIOutputLimit - b.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(data), nil
	}
	if len(data) > remaining {
		_, _ = b.Buffer.Write(data[:remaining])
		b.truncated = true
		return len(data), nil
	}
	return b.Buffer.Write(data)
}

var allowedTaskCLIRootCommands = map[string]struct{}{
	"agent":      {},
	"attachment": {},
	"autopilot":  {},
	"chat":       {},
	"help":       {},
	"issue":      {},
	"label":      {},
	"project":    {},
	"property":   {},
	"repo":       {},
	"runtime":    {},
	"skill":      {},
	"squad":      {},
	"version":    {},
	"workspace":  {},
}

var forbiddenTaskCLIFlags = []string{
	"--debug",
	"--profile",
	"--server-url",
	"--workspace-id",
	"--allow-external-file",
}

var taskCLIInputFileFlags = []string{
	"--attachment",
	"--content-file",
	"--custom-env-file",
	"--description-file",
	"--file",
	"--mcp-config-file",
}

var taskCLIOutputDirFlags = []string{
	"--output-dir",
	"-o",
}

func validateTaskCLIArgs(args []string, workDir string) error {
	if len(args) == 0 {
		return errors.New("task CLI command is required")
	}
	if len(args) > 128 {
		return errors.New("task CLI command has too many arguments")
	}
	for _, arg := range args {
		if len(arg) > 8192 || strings.ContainsRune(arg, 0) {
			return errors.New("task CLI command contains an invalid argument")
		}
		for _, flag := range forbiddenTaskCLIFlags {
			if arg == flag || strings.HasPrefix(arg, flag+"=") {
				return fmt.Errorf("%s is not available in a task CLI command", flag)
			}
		}
	}

	rootIndex := taskCLIRootIndex(args)
	if rootIndex < 0 {
		return errors.New("task CLI command is required")
	}
	root := args[rootIndex]
	if _, ok := allowedTaskCLIRootCommands[root]; !ok {
		return fmt.Errorf("%s is not available in a task CLI command", root)
	}
	if err := validateTaskCLICommandPolicy(args, rootIndex); err != nil {
		return err
	}
	for index := range args {
		for _, flag := range taskCLIInputFileFlags {
			path, found, err := taskCLIFlagValue(args, index, flag)
			if err != nil {
				return err
			}
			if found {
				if err := validateTaskCLIFilePath(workDir, path); err != nil {
					return fmt.Errorf("%s: %w", flag, err)
				}
			}
		}
		for _, flag := range taskCLIOutputDirFlags {
			path, found, err := taskCLIFlagValue(args, index, flag)
			if err != nil {
				return err
			}
			if found {
				if err := validateTaskCLIOutputDirPath(workDir, path); err != nil {
					return fmt.Errorf("%s: %w", flag, err)
				}
			}
		}
	}
	if err := validateTaskCLIAttachmentPath(args, rootIndex, workDir); err != nil {
		return err
	}
	return nil
}

func taskCLIRootIndex(args []string) int {
	for index, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			return index
		}
	}
	return -1
}

var taskCLIRestrictedSubcommands = map[string]map[string]struct{}{
	"repo": {
		"checkout": {},
		"list":     {},
	},
	"runtime": {
		"activity": {},
		"list":     {},
		"usage":    {},
	},
}

func validateTaskCLICommandPolicy(args []string, rootIndex int) error {
	allowed, restricted := taskCLIRestrictedSubcommands[args[rootIndex]]
	if !restricted {
		return nil
	}
	if rootIndex+1 >= len(args) {
		return fmt.Errorf("%s requires an allowed subcommand in a task CLI command", args[rootIndex])
	}
	subcommand := args[rootIndex+1]
	if _, ok := allowed[subcommand]; !ok {
		return fmt.Errorf("%s %s is not available in a task CLI command", args[rootIndex], subcommand)
	}
	return nil
}

func taskCLIFlagValue(args []string, index int, flag string) (string, bool, error) {
	arg := args[index]
	if strings.HasPrefix(arg, flag+"=") {
		return strings.TrimPrefix(arg, flag+"="), true, nil
	}
	if flag == "-o" && strings.HasPrefix(arg, "-o") && len(arg) > len(flag) {
		return strings.TrimPrefix(arg, flag), true, nil
	}
	if arg != flag {
		return "", false, nil
	}
	if index+1 >= len(args) {
		return "", true, fmt.Errorf("%s requires a file path", flag)
	}
	return args[index+1], true, nil
}

func validateTaskCLIFilePath(workDir, value string) error {
	if strings.TrimSpace(value) == "" || value == "-" {
		return errors.New("file path is required")
	}
	resolvedWorkDir, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return fmt.Errorf("resolve task workdir: %w", err)
	}
	path := value
	if !filepath.IsAbs(path) {
		path = filepath.Join(resolvedWorkDir, path)
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("resolve file path: %w", err)
	}
	relative, err := filepath.Rel(resolvedWorkDir, resolvedPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("file path must stay inside the task workdir")
	}
	return nil
}

func validateTaskCLIOutputDirPath(workDir, value string) error {
	if strings.TrimSpace(value) == "" || value == "-" {
		return errors.New("output directory is required")
	}
	resolvedWorkDir, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return fmt.Errorf("resolve task workdir: %w", err)
	}
	path := value
	if !filepath.IsAbs(path) {
		path = filepath.Join(resolvedWorkDir, path)
	}
	for {
		resolvedPath, err := filepath.EvalSymlinks(path)
		if err == nil {
			if taskCLIPathWithin(resolvedWorkDir, resolvedPath) {
				return nil
			}
			return errors.New("output directory must stay inside the task workdir")
		}
		if !os.IsNotExist(err) {
			return fmt.Errorf("resolve output directory: %w", err)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return fmt.Errorf("resolve output directory: %w", err)
		}
		path = parent
	}
}

func taskCLIPathWithin(workDir, path string) bool {
	relative, err := filepath.Rel(workDir, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func validateTaskCLIAttachmentPath(args []string, rootIndex int, workDir string) error {
	if rootIndex+2 >= len(args) || args[rootIndex] != "attachment" || args[rootIndex+1] != "upload" {
		return nil
	}
	for index := rootIndex + 2; index < len(args); index++ {
		arg := args[index]
		if arg == "--task" {
			index++
			continue
		}
		if strings.HasPrefix(arg, "--task=") || strings.HasPrefix(arg, "-") {
			continue
		}
		if err := validateTaskCLIFilePath(workDir, arg); err != nil {
			return fmt.Errorf("attachment upload path: %w", err)
		}
		return nil
	}
	return nil
}
