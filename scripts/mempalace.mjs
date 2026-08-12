#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const allowedTools = Object.freeze([
  "mempalace_status",
  "mempalace_search",
  "mempalace_list_wings",
  "mempalace_list_rooms",
  "mempalace_get_drawer",
  "mempalace_check_duplicate",
  "mempalace_add_drawer",
  "mempalace_checkpoint",
  "mempalace_diary_read",
  "mempalace_diary_write",
]);

export const requiredExcludePatterns = Object.freeze([
  ".env*",
  ".multica*",
  ".multica/",
  ".multica-*",
  ".context/",
  ".agent_context/",
  ".mempalace-local/",
  "node_modules/",
  ".turbo/",
  ".next/",
  "dist/",
  "dist-electron/",
  "build/",
  "out/",
  "coverage/",
  "test-results/",
  "server/bin/",
  "server/tmp/",
  "*.log",
]);

const forbiddenTools = Object.freeze([
  "mempalace_delete_drawer",
  "mempalace_delete_by_source",
  "mempalace_sync",
  "mempalace_mine",
  "mempalace_hook_settings",
  "mempalace_event_append",
  "mempalace_event_list",
  "mempalace_event_wait",
  "mempalace_event_ack",
]);

const scriptPath = fileURLToPath(import.meta.url);
const expectedVersion = "3.7.0";
const pythonVersion = "3.12";

function fail(message) {
  throw new Error(`mempalace: ${message}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if ((await exists(join(current, ".git"))) && (await exists(join(current, "package.json")))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      fail(`could not find a Git repository above ${start}`);
    }
    current = parent;
  }
}

export function pathsFor(root) {
  const local = join(root, ".mempalace-local");
  const tools = join(root, "tools", "mempalace");
  const executable = process.platform === "win32" ? "mempalace.exe" : "mempalace";
  const mcpExecutable = process.platform === "win32" ? "mempalace-mcp.exe" : "mempalace-mcp";
  return {
    root,
    local,
    tools,
    palace: join(local, "palace"),
    home: join(local, "home"),
    cache: join(local, "cache"),
    tmp: join(local, "tmp"),
    python: join(local, "python"),
    venv: join(local, "venv"),
    lock: join(local, "mcp-writer.lock"),
    receipt: join(local, "runtime.json"),
    configDir: join(local, "home", ".mempalace"),
    config: join(local, "home", ".mempalace", "config.json"),
    mcpLog: join(local, "palace", "mempalace-mcp.log"),
    cli: join(local, "venv", process.platform === "win32" ? "Scripts" : "bin", executable),
    mcp: join(
      local,
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
      mcpExecutable,
    ),
    pythonExecutable: join(
      local,
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    ),
  };
}

function assertProjectPaths(paths) {
  for (const [name, path] of Object.entries(paths)) {
    if (typeof path === "string" && name !== "root" && !isWithin(paths.root, path)) {
      fail(`${name} path escapes the repository: ${path}`);
    }
  }
}

export async function assertLocalStorage(paths) {
  const canonicalRoot = await realpath(paths.root);
  const localInfo = await lstat(paths.local).catch(() => null);
  if (!localInfo) return;
  if (localInfo.isSymbolicLink()) {
    fail("project storage must not be a symbolic link: " + paths.local);
  }
  const canonicalLocal = await realpath(paths.local);
  if (!isWithin(canonicalRoot, canonicalLocal)) {
    fail("project storage resolves outside the repository: " + canonicalLocal);
  }

  for (const path of [
    paths.palace,
    paths.home,
    paths.cache,
    paths.tmp,
    paths.python,
    paths.venv,
    paths.configDir,
    paths.config,
    paths.receipt,
    paths.lock,
    paths.mcpLog,
  ]) {
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      fail("project storage path must not be a symbolic link: " + path);
    }
    const canonical = await realpath(path);
    if (!isWithin(canonicalLocal, canonical)) {
      fail("project storage path resolves outside .mempalace-local: " + canonical);
    }
  }
}

export function isolatedEnv(paths, base = process.env) {
  assertProjectPaths(paths);
  const inherited = { ...base };
  for (const key of Object.keys(inherited)) {
    if (
      /^(?:MEMPAL(?:ACE)?_|UV_|PIP_|HF_|HUGGINGFACE_|TRANSFORMERS_|CHROMA_|POSTHOG_|CONDA|MULTICA_|VIRTUAL_ENV$|CODEX_HOME$|PYTHON(?:HOME|PATH|STARTUP|USERBASE)$)/i.test(
        key,
      ) ||
      /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS?|ACCESS_KEY(?:_ID)?)$/i.test(
        key,
      ) ||
      /(?:^|_)(?:DATABASE|POSTGRES(?:QL)?|REDIS|MYSQL)_URL$|(?:^|_)(?:DSN|CONNECTION_STRING)$/i.test(
        key,
      )
    ) {
      delete inherited[key];
    }
  }
  const xdg = join(paths.cache, "xdg");
  const huggingFace = join(paths.cache, "huggingface");
  const uvCache = join(paths.cache, "uv");
  const pipCache = join(paths.cache, "pip");
  return {
    ...inherited,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: join(paths.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(paths.home, "AppData", "Local"),
    XDG_CACHE_HOME: xdg,
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_STATE_HOME: join(paths.home, ".local", "state"),
    HF_HOME: huggingFace,
    HUGGINGFACE_HUB_CACHE: join(huggingFace, "hub"),
    TRANSFORMERS_CACHE: join(huggingFace, "transformers"),
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TRANSFORMERS_OFFLINE: "1",
    UV_CACHE_DIR: uvCache,
    UV_PYTHON_INSTALL_DIR: paths.python,
    UV_PROJECT_ENVIRONMENT: paths.venv,
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_DEFAULT_INDEX: "https://pypi.org/simple",
    UV_KEYRING_PROVIDER: "disabled",
    UV_NO_CONFIG: "1",
    PIP_CACHE_DIR: pipCache,
    PIP_INDEX_URL: "https://pypi.org/simple",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    TMP: paths.tmp,
    TEMP: paths.tmp,
    TMPDIR: paths.tmp,
    MEMPALACE_PALACE_PATH: paths.palace,
    MEMPAL_PALACE_PATH: paths.palace,
    MEMPALACE_BACKEND: "chroma",
    MEMPALACE_BACKEND_EXPLICIT: "chroma",
    MEMPALACE_EMBEDDING_MODEL: "embeddinggemma",
    MEMPALACE_EMBEDDING_DEVICE: "auto",
    MEMPALACE_LOG_FILE: paths.mcpLog,
    MEMPALACE_HUB_FORWARD: "0",
    MEMPALACE_HOOKS_AUTO_SAVE: "0",
    MEMPALACE_HOOKS_DAEMON: "0",
    MEMPALACE_HOOK_WRITE_ROUTING: "direct",
    MEMPALACE_CLI_WRITE_ROUTING: "direct",
    MEMPALACE_WRITE_ROUTING: "direct",
    MEMPALACE_MCP_ALLOW_PEER_WRITER: "0",
    MEMPALACE_MCP_READ_ONLY: "0",
    MEMPALACE_EAGER_WARMUP: "0",
    ANONYMIZED_TELEMETRY: "False",
    DO_NOT_TRACK: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPYCACHEPREFIX: join(paths.cache, "pycache"),
    PYTHONUTF8: "1",
  };
}

async function ensureLocalDirectories(paths) {
  await assertLocalStorage(paths);
  await Promise.all([
    mkdir(paths.palace, { recursive: true }),
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
    mkdir(paths.tmp, { recursive: true }),
    mkdir(paths.python, { recursive: true }),
  ]);
  await assertLocalStorage(paths);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      windowsHide: true,
    });
    options.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => (stdout += chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) {
        rejectRun(new Error(`${command} stopped by signal ${signal}`));
      } else if (code !== 0 && !options.allowFailure) {
        const detail = stderr.trim() || stdout.trim();
        rejectRun(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ""}`));
      } else {
        resolveRun({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

export async function assertLocked(paths) {
  const lockPath = join(paths.tools, "uv.lock");
  if (!(await exists(lockPath))) fail(`missing lock file: ${lockPath}`);
  const lock = await readFile(lockPath, "utf8");
  if (
    !lock.includes('requires-python = "==3.12.*"') ||
    !lock.includes('name = "multica-mempalace-runtime"') ||
    !lock.includes('source = { virtual = "." }') ||
    !lock.includes('name = "mempalace"') ||
    !lock.includes('version = "3.7.0"') ||
    !lock.includes(
      "sha256:6ef6f1ae916de7bba1295b4c42e89ec9ae8a4aabb1e1309ff8488cca583bf673",
    )
  ) {
    fail("dependency lock does not match the reviewed MemPalace 3.7.0/Python 3.12 runtime");
  }
}

async function installedVersion(paths, env) {
  if (!(await exists(paths.cli))) return null;
  const result = await run(paths.cli, ["--version"], {
    cwd: paths.root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.stdout.trim();
}

async function installedPythonVersion(paths, env) {
  if (!(await exists(paths.pythonExecutable))) return null;
  const result = await run(
    paths.pythonExecutable,
    ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    {
      cwd: paths.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function runtimeFingerprint(paths) {
  for (const filename of ["pyproject.toml", "uv.lock"]) {
    if (!(await exists(join(paths.tools, filename)))) {
      fail(`missing dependency input: ${join(paths.tools, filename)}`);
    }
  }
  return {
    schema_version: 1,
    mempalace_version: expectedVersion,
    python_version: pythonVersion,
    pyproject_sha256: await sha256(join(paths.tools, "pyproject.toml")),
    uv_lock_sha256: await sha256(join(paths.tools, "uv.lock")),
  };
}

export async function verifyRuntimeReceipt(paths) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(paths.receipt, "utf8"));
  } catch {
    fail("project runtime receipt is missing or invalid; run `pnpm memory:setup`");
  }
  const expected = await runtimeFingerprint(paths);
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) {
      fail(
        "MemPalace dependency inputs changed after setup; run `pnpm memory:setup` to reconcile the locked runtime",
      );
    }
  }
}

async function verifyInstalledRuntime(paths, env) {
  if (!(await exists(paths.mcp))) {
    fail("project runtime is missing; run `pnpm memory:setup`");
  }
  const version = await installedVersion(paths, env);
  if (!version) fail("project runtime is missing; run `pnpm memory:setup`");
  if (version !== `MemPalace ${expectedVersion}`) {
    fail(`expected MemPalace ${expectedVersion}, found ${version}; rerun \`pnpm memory:setup\``);
  }
  const installedPython = await installedPythonVersion(paths, env);
  if (installedPython !== pythonVersion) {
    fail(
      `expected project Python ${pythonVersion}, found ${installedPython ?? "none"}; rerun \`pnpm memory:setup\``,
    );
  }
}

async function requireRuntime(paths, env) {
  await assertLocalStorage(paths);
  await verifyRuntimeReceipt(paths);
  await verifyInstalledRuntime(paths, env);
}

export async function requireInitialized(paths) {
  await assertLocalStorage(paths);
  const required = [
    join(paths.root, "mempalace.yaml"),
    join(paths.root, "entities.json"),
    paths.config,
    paths.palace,
  ];
  const missing = [];
  for (const path of required) if (!(await exists(path))) missing.push(path);
  if (missing.length) {
    fail(`project memory is not initialized; run \`pnpm memory:init\` (missing ${missing[0]})`);
  }
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  if (!isWithin(paths.local, config.palace_path)) {
    fail(`configured palace path escapes .mempalace-local: ${config.palace_path}`);
  }
  if (resolve(config.palace_path) !== resolve(paths.palace)) {
    fail(`configured palace path differs from the project palace: ${config.palace_path}`);
  }
  if (config.embedding_model !== "embeddinggemma" || config.backend !== "chroma") {
    fail("local config must use embeddinggemma with the chroma backend");
  }
  if (config.hooks?.auto_save !== false) {
    fail("local config must keep automatic memory saving disabled");
  }
}

export async function verifyMiningPolicy(paths) {
  for (const configPath of [
    join(paths.tools, "mempalace.template.yaml"),
    join(paths.root, "mempalace.yaml"),
  ]) {
    const config = await readFile(configPath, "utf8");
    for (const pattern of requiredExcludePatterns) {
      if (!config.includes(`  - "${pattern}"`)) {
        fail(`required mining exclusion ${JSON.stringify(pattern)} is missing from ${configPath}`);
      }
    }
  }
}

export function uvSetupCommands(paths) {
  return [
    ["python", "install", pythonVersion, "--install-dir", paths.python],
    ["lock", "--check", "--offline", "--project", paths.tools, "--python", pythonVersion],
    [
      "sync",
      "--locked",
      "--project",
      paths.tools,
      "--python",
      pythonVersion,
      "--python-preference",
      "only-managed",
      "--no-install-project",
      "--no-dev",
    ],
  ];
}

async function setup(paths, args) {
  if (args.length) fail(`setup takes no options, received: ${args.join(" ")}`);
  await ensureLocalDirectories(paths);
  const env = isolatedEnv(paths);
  const release = await acquireWriterLock(paths);
  try {
    await assertLocked(paths);
    for (const commandArgs of uvSetupCommands(paths)) {
      await run("uv", commandArgs, { cwd: paths.root, env });
    }
    await verifyInstalledRuntime(paths, env);
    await run(
      paths.pythonExecutable,
      [
        "-c",
        "from mempalace.embedding import get_embedding_function; " +
          "get_embedding_function(model='embeddinggemma')(input=['Multica project memory'])",
      ],
      {
        cwd: paths.root,
        env: { ...env, HF_HUB_OFFLINE: "0", TRANSFORMERS_OFFLINE: "0" },
      },
    );
    await writeFile(
      paths.receipt,
      `${JSON.stringify(await runtimeFingerprint(paths), null, 2)}\n`,
      "utf8",
    );
  } finally {
    await release();
  }
  console.log(`MemPalace ${expectedVersion} is installed in ${relative(paths.root, paths.venv)}.`);
}

async function init(paths, args) {
  if (args.length) fail(`init takes no options, received: ${args.join(" ")}`);
  const env = isolatedEnv(paths);
  await requireRuntime(paths, env);
  await ensureLocalDirectories(paths);
  const release = await acquireWriterLock(paths);
  try {
    await mkdir(paths.configDir, { recursive: true });
    await cp(join(paths.tools, "mempalace.template.yaml"), join(paths.root, "mempalace.yaml"), {
      force: false,
      errorOnExist: false,
    });
    await cp(join(paths.tools, "entities.template.json"), join(paths.root, "entities.json"), {
      force: false,
      errorOnExist: false,
    });
    const config = {
      palace_path: paths.palace,
      collection_name: "mempalace_drawers",
      backend: "chroma",
      embedding_model: "embeddinggemma",
      embedding_device: "auto",
      hooks: { auto_save: false },
    };
    await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } finally {
    await release();
  }
  console.log("Project memory initialized. No repository content was mined.");
}

export async function resolveMineTarget(paths, value) {
  const candidate = resolve(paths.root, value ?? ".");
  if (!isWithin(paths.root, candidate)) fail(`mine target escapes the repository: ${candidate}`);
  const targetStat = await stat(candidate).catch(() => null);
  if (!targetStat?.isDirectory()) fail(`mine target must be an existing directory: ${candidate}`);
  const canonicalRoot = await realpath(paths.root);
  const canonicalTarget = await realpath(candidate);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    fail(`mine target resolves outside the repository: ${canonicalTarget}`);
  }
  return canonicalTarget;
}

export function parseMineArgs(args) {
  let apply = false;
  let targetValue;
  for (const arg of args) {
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") continue;
    else if (arg.startsWith("-")) fail(`unknown mine option: ${arg}`);
    else if (targetValue) fail("mine accepts at most one repository-relative directory");
    else targetValue = arg;
  }
  return { apply, targetValue };
}

async function mine(paths, args) {
  const { apply, targetValue } = parseMineArgs(args);
  const target = await resolveMineTarget(paths, targetValue);
  const env = isolatedEnv(paths);
  await requireRuntime(paths, env);
  await requireInitialized(paths);
  await verifyMiningPolicy(paths);
  const commandArgs = [
    join(paths.tools, "project_mine.py"),
    "--root",
    paths.root,
    "--target",
    target,
    "--palace",
    paths.palace,
    "--wing",
    "multica",
    "--agent",
    "multica",
  ];
  if (!apply) commandArgs.push("--dry-run");
  if (!apply) {
    await run(paths.pythonExecutable, commandArgs, { cwd: paths.root, env });
    return;
  }
  const release = await acquireWriterLock(paths);
  try {
    await run(paths.pythonExecutable, commandArgs, { cwd: paths.root, env });
  } finally {
    await release();
  }
}

export async function readCodexTools(paths) {
  const config = await readFile(join(paths.root, ".codex", "config.toml"), "utf8");
  const block = config.match(/enabled_tools\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

async function doctor(paths, args) {
  if (args.length) fail(`doctor takes no options, received: ${args.join(" ")}`);
  const env = isolatedEnv(paths);
  await assertLocked(paths);
  await requireRuntime(paths, env);
  await requireInitialized(paths);
  await verifyMiningPolicy(paths);
  const configuredTools = await readCodexTools(paths);
  if (JSON.stringify(configuredTools) !== JSON.stringify(allowedTools)) {
    fail("Codex MCP enabled_tools does not match the reviewed project allowlist");
  }
  for (const tool of forbiddenTools) {
    if (configuredTools.includes(tool)) fail(`forbidden MCP tool is enabled: ${tool}`);
  }
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "HF_HOME",
    "UV_CACHE_DIR",
    "UV_PYTHON_INSTALL_DIR",
    "UV_PROJECT_ENVIRONMENT",
    "TMP",
    "TEMP",
    "TMPDIR",
    "MEMPALACE_PALACE_PATH",
  ]) {
    if (!isWithin(paths.local, env[key])) fail(`${key} is not project-local: ${env[key]}`);
  }
  console.log(`MemPalace doctor: OK (${expectedVersion}, ${configuredTools.length} MCP tools).`);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireWriterLock(paths) {
  await mkdir(paths.local, { recursive: true });
  await assertLocalStorage(paths);
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staging = `${paths.lock}.${process.pid}.${token}`;
    try {
      await mkdir(staging);
      await writeFile(
        join(staging, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          started_at: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await rename(staging, paths.lock);
      return async () => {
        let owner = {};
        try {
          owner = JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8"));
        } catch {}
        if (owner.pid === process.pid && owner.token === token) {
          await rm(paths.lock, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      let owner = {};
      try {
        owner = JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8"));
      } catch {}
      if (!owner.pid && attempt === 0) {
        await delay(50);
        try {
          owner = JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8"));
        } catch {}
      }
      if (processAlive(Number(owner.pid))) {
        fail(`another writable MemPalace process is active (pid ${owner.pid})`);
      }
      await rm(paths.lock, { recursive: true, force: true });
    }
  }
  fail("could not acquire the project MemPalace writer lock");
}

function mcpCommand(paths) {
  return { executable: paths.mcp, args: ["--palace", paths.palace, "--backend", "chroma"] };
}

export async function startMcp(paths, args, options = {}) {
  if (args.length) fail(`mcp takes no options, received: ${args.join(" ")}`);
  const env = isolatedEnv(paths);
  if (!options.skipRuntimeCheck) await requireRuntime(paths, env);
  await requireInitialized(paths);
  const release = await acquireWriterLock(paths);
  const command = options.command ?? mcpCommand(paths);
  const runner = options.runner ?? run;
  let child;
  const signalHandlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [signal, () => child?.kill(signal)]),
  );
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  try {
    await runner(command.executable, command.args, {
      cwd: paths.root,
      env,
      onSpawn: (spawned) => (child = spawned),
    });
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await release();
  }
}

function printHelp() {
  console.log(`Usage: node scripts/mempalace.mjs <command>\n\nCommands:\n  setup\n  init\n  mine [repo-relative-directory] [--dry-run|--apply]\n  doctor\n  mcp\n  smoke`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  const root = await findRepoRoot();
  const paths = pathsFor(root);
  assertProjectPaths(paths);
  switch (command) {
    case "setup":
      await setup(paths, args);
      break;
    case "init":
      await init(paths, args);
      break;
    case "mine":
      await mine(paths, args);
      break;
    case "doctor":
      await doctor(paths, args);
      break;
    case "mcp":
      await startMcp(paths, args);
      break;
    case "smoke":
      await realSmoke(paths, args);
      break;
    default:
      fail(`unknown command: ${command}`);
  }
}

async function realSmoke(paths, args) {
  if (args.length) fail(`smoke takes no options, received: ${args.join(" ")}`);
  if (process.env.MEMPALACE_RUN_REAL_SMOKE !== "1") {
    fail("real smoke test is opt-in; set MEMPALACE_RUN_REAL_SMOKE=1 after setup and init");
  }
  const env = isolatedEnv(paths);
  await requireRuntime(paths, env);
  await requireInitialized(paths);
  await verifyMiningPolicy(paths);
  const configuredTools = await readCodexTools(paths);
  if (JSON.stringify(configuredTools) !== JSON.stringify(allowedTools)) {
    fail("Codex MCP enabled_tools does not match the reviewed project allowlist");
  }
  const canary = `multica-memory-smoke-${randomUUID()}`;
  const source = "scripts/mempalace.mjs#real-smoke";
  const writeResponses = await runMcpSession(paths, env, [
    { method: "tools/list", params: {} },
    {
      method: "tools/call",
      params: {
        name: "mempalace_add_drawer",
        arguments: {
          wing: "multica",
          room: "implementation",
          content: canary,
          source_file: source,
          added_by: "multica-smoke",
        },
      },
    },
  ]);
  const writeResult = parseToolResult(responseFor(writeResponses, 3));
  if (writeResult.success !== true) {
    fail(`real smoke write was not acknowledged: ${JSON.stringify(writeResult)}`);
  }
  const offlineEnv = {
    ...env,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
  const responses = await runMcpSession(paths, offlineEnv, [
    { method: "tools/list", params: {} },
    {
      method: "tools/call",
      params: {
        name: "mempalace_search",
        arguments: { query: canary, wing: "multica", limit: 5 },
      },
    },
  ]);
  const search = parseToolResult(responseFor(responses, 3));
  const hit = search.results?.find((item) => item.text?.includes(canary));
  if (!hit || hit.wing !== "multica" || !String(hit.source_path ?? "").includes(source)) {
    fail(`real smoke search did not return the persisted canary with source and wing: ${canary}`);
  }
  console.log(`MemPalace real smoke: OK (${canary}).`);
}

function responseFor(responses, id) {
  const response = responses.find((item) => item.id === id);
  if (!response) fail(`MCP returned no response for request ${id}`);
  return response;
}

function parseToolResult(response) {
  if (response?.error) fail(`MCP tool failed: ${JSON.stringify(response.error)}`);
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) fail(`MCP tool returned no text: ${JSON.stringify(response)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { success: response?.result?.isError !== true, text };
  }
}

async function runMcpSession(paths, env, calls) {
  const release = await acquireWriterLock(paths);
  const child = spawn(paths.mcp, ["--palace", paths.palace, "--backend", "chroma"], {
    cwd: paths.root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const responses = [];
  let buffer = "";
  let parseError;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        responses.push(JSON.parse(line));
      } catch (error) {
        parseError = error;
      }
    }
  });
  const exit = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code) => {
      resolveExit({
        error: code === 0 ? null : new Error(`MCP exited with code ${code}: ${stderr.trim()}`),
      });
    });
  });
  try {
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const waitForResponse = async (id) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const response = responses.find((item) => item.id === id);
        if (response) return response;
        if (parseError) fail(`MCP returned invalid JSON: ${parseError.message}`);
        if (child.exitCode !== null) {
          fail(`MCP exited before responding to request ${id}: ${stderr.trim()}`);
        }
        await delay(25);
      }
      child.kill();
      fail(`MCP smoke request ${id} timed out after 180 seconds`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "multica-memory-smoke", version: "1.0.0" },
      },
    });
    await waitForResponse(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    for (const [index, call] of calls.entries()) {
      const id = index + 2;
      send({ jsonrpc: "2.0", id, ...call });
      await waitForResponse(id);
    }
    child.stdin.end();
    const exitOutcome = await exit;
    if (exitOutcome.error) throw exitOutcome.error;
    if (buffer.trim()) {
      try {
        responses.push(JSON.parse(buffer));
      } catch (error) {
        parseError = error;
      }
    }
    if (parseError) fail(`MCP returned invalid JSON: ${parseError.message}`);
    const rawNames = responseFor(responses, 2)?.result?.tools?.map((tool) => tool.name) ?? [];
    for (const tool of allowedTools) if (!rawNames.includes(tool)) fail(`MCP is missing ${tool}`);
    return responses;
  } finally {
    if (child.exitCode === null) child.kill();
    await exit;
    await release();
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
