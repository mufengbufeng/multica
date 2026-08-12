import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  acquireWriterLock,
  allowedTools,
  assertLocalStorage,
  assertLocked,
  findRepoRoot,
  isolatedEnv,
  parseMineArgs,
  pathsFor,
  readCodexTools,
  requiredExcludePatterns,
  requireInitialized,
  resolveMineTarget,
  runtimeFingerprint,
  startMcp,
  uvSetupCommands,
  verifyMiningPolicy,
  verifyRuntimeReceipt,
} from "./mempalace.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "multica-mempalace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, ".git")),
    mkdir(join(root, ".codex")),
    mkdir(join(root, "tools", "mempalace"), { recursive: true }),
  ]);
  await writeFile(join(root, "package.json"), '{"name":"fixture","type":"module"}\n');
  await writeFile(
    join(root, "tools", "mempalace", "pyproject.toml"),
    '[project]\nname = "fixture"\nversion = "0.0.0"\nrequires-python = "==3.12.*"\n',
  );
  await writeFile(
    join(root, "tools", "mempalace", "uv.lock"),
    [
      "version = 1",
      'requires-python = "==3.12.*"',
      'name = "multica-mempalace-runtime"',
      'source = { virtual = "." }',
      'name = "mempalace"',
      'version = "3.7.0"',
      "sha256:6ef6f1ae916de7bba1295b4c42e89ec9ae8a4aabb1e1309ff8488cca583bf673",
      "",
    ].join("\n"),
  );
  return { root, paths: pathsFor(root) };
}

async function initializeFixture(paths, palacePath = paths.palace) {
  await Promise.all([
    mkdir(paths.palace, { recursive: true }),
    mkdir(paths.configDir, { recursive: true }),
    writeFile(join(paths.root, "mempalace.yaml"), "wing: multica\n"),
    writeFile(join(paths.root, "entities.json"), '{"people":[]}\n'),
  ]);
  await writeFile(
    paths.config,
    `${JSON.stringify({
      palace_path: palacePath,
      collection_name: "mempalace_drawers",
      backend: "chroma",
      embedding_model: "embeddinggemma",
      hooks: { auto_save: false },
    })}\n`,
  );
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

test("findRepoRoot locates the checkout from a nested directory", async (t) => {
  const { root } = await fixture(t);
  const nested = join(root, "packages", "example", "src");
  await mkdir(nested, { recursive: true });
  assert.equal(await findRepoRoot(nested), root);
});

test("isolatedEnv redirects every writable dependency location into the checkout", async (t) => {
  const { paths } = await fixture(t);
  const env = isolatedEnv(paths, {
    PATH: process.env.PATH,
    APPDATA: "C:\\outside\\roaming",
    CODEX_HOME: "C:\\outside\\codex",
    LOCALAPPDATA: "C:\\outside\\local",
    HF_ENDPOINT: "https://example.invalid",
    CODEX_API_KEY: "must-not-reach-mempalace",
    MEMPALACE_MCP_READ_ONLY: "1",
    MEMPALACE_PGVECTOR_DSN: "postgres://outside",
    MULTICA_TASK_CLI_CAPABILITY: "must-not-reach-mempalace",
    MULTICA_TASK_FILES_DIR: "C:\\outside\\task-files",
    MULTICA_TOKEN: "must-not-reach-mempalace",
    MY_DATABASE_URL: "postgres://outside",
    my_service_token: "must-not-reach-mempalace",
    OPENAI_ACCESS_TOKEN: "must-not-reach-mempalace",
    PIP_INDEX_URL: "https://example.invalid/simple",
    PYTHONPATH: "C:\\outside\\python",
    UV_CONFIG_FILE: "C:\\outside\\uv.toml",
    UV_INDEX: "https://example.invalid/simple",
  });
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "HF_HOME",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "UV_CACHE_DIR",
    "UV_PYTHON_INSTALL_DIR",
    "UV_PROJECT_ENVIRONMENT",
    "PIP_CACHE_DIR",
    "TMP",
    "TEMP",
    "TMPDIR",
    "MEMPALACE_PALACE_PATH",
    "MEMPAL_PALACE_PATH",
    "MEMPALACE_LOG_FILE",
    "PYTHONPYCACHEPREFIX",
  ]) {
    assert.equal(isWithin(paths.local, env[key]), true, `${key} escaped the checkout`);
  }
  assert.equal(env.MEMPALACE_BACKEND, "chroma");
  assert.equal(env.MEMPALACE_EMBEDDING_MODEL, "embeddinggemma");
  assert.equal(env.MEMPALACE_HUB_FORWARD, "0");
  assert.equal(env.MEMPALACE_HOOKS_AUTO_SAVE, "0");
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.HF_HUB_DISABLE_TELEMETRY, "1");
  assert.equal(env.TRANSFORMERS_OFFLINE, "1");
  assert.equal(env.UV_PYTHON_PREFERENCE, "only-managed");
  assert.equal(env.UV_DEFAULT_INDEX, "https://pypi.org/simple");
  assert.equal(env.UV_NO_CONFIG, "1");
  assert.equal(env.UV_KEYRING_PROVIDER, "disabled");
  assert.equal(env.PIP_INDEX_URL, "https://pypi.org/simple");
  assert.equal(env.MEMPALACE_MCP_READ_ONLY, "0");
  assert.equal(env.MEMPALACE_CLI_WRITE_ROUTING, "direct");
  assert.equal(env.PYTHONNOUSERSITE, "1");
  for (const key of [
    "HF_ENDPOINT",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "MEMPALACE_PGVECTOR_DSN",
    "MULTICA_TASK_CLI_CAPABILITY",
    "MULTICA_TASK_FILES_DIR",
    "MULTICA_TOKEN",
    "MY_DATABASE_URL",
    "OPENAI_ACCESS_TOKEN",
    "PYTHONPATH",
    "UV_CONFIG_FILE",
    "UV_INDEX",
    "my_service_token",
  ]) {
    assert.equal(env[key], undefined, key + " leaked from the parent process");
  }
});

test("mining is dry-run by default and rejects paths outside the repository", async (t) => {
  const { root, paths } = await fixture(t);
  assert.deepEqual(parseMineArgs([]), { apply: false, targetValue: undefined });
  assert.deepEqual(parseMineArgs(["docs", "--apply"]), {
    apply: true,
    targetValue: "docs",
  });
  assert.throws(() => parseMineArgs(["--unknown"]), /unknown mine option/);
  await assert.rejects(resolveMineTarget(paths, ".."), /escapes the repository/);
  await mkdir(join(root, "docs"));
  assert.equal(await resolveMineTarget(paths, "docs"), await resolve(join(root, "docs")));
});

test("initialization rejects a palace outside .mempalace-local", async (t) => {
  const { paths } = await fixture(t);
  await initializeFixture(paths, join(paths.root, "outside-palace"));
  await assert.rejects(requireInitialized(paths), /escapes .mempalace-local/);
});

test("project storage rejects redirected local paths", async (t) => {
  const { paths } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "multica-mempalace-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(paths.local);
  await mkdir(join(outside, "palace"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(join(outside, "palace"), paths.palace, linkType);
  await assert.rejects(assertLocalStorage(paths), /must not be a symbolic link|resolves outside/);
});

test("the dependency lock check is local and rejects missing or drifted locks", async (t) => {
  const { paths } = await fixture(t);
  await assertLocked(paths);
  await writeFile(join(paths.tools, "uv.lock"), "version = 1\n");
  await assert.rejects(assertLocked(paths), /does not match/);
  await rm(join(paths.tools, "uv.lock"));
  await assert.rejects(assertLocked(paths), /missing lock file/);
});

test("the frozen lock contains uvicorn standard dependencies for Python 3.12", async () => {
  const lock = (
    await readFile(join(repositoryRoot, "tools", "mempalace", "uv.lock"), "utf8")
  ).replaceAll("\r\n", "\n");
  for (const [name, version] of [
    ["httptools", "0.7.1"],
    ["uvicorn", "0.44.0"],
    ["uvloop", "0.22.1"],
    ["watchfiles", "1.1.1"],
    ["websockets", "16.0"],
  ]) {
    assert.match(
      lock,
      new RegExp(
        String.raw`\[\[package\]\]\nname = "${name}"\nversion = "${version}"`,
      ),
    );
  }
  assert.match(
    lock,
    /\[package\.optional-dependencies\]\nstandard = \[[\s\S]*?\{ name = "httptools" \}[\s\S]*?\{ name = "watchfiles" \}[\s\S]*?\{ name = "websockets" \}/,
  );
});

test("setup installs project Python before validating and syncing the lock", async (t) => {
  const { paths } = await fixture(t);
  assert.deepEqual(uvSetupCommands(paths), [
    ["python", "install", "3.12", "--install-dir", paths.python],
    ["lock", "--check", "--offline", "--project", paths.tools, "--python", "3.12"],
    [
      "sync",
      "--locked",
      "--project",
      paths.tools,
      "--python",
      "3.12",
      "--python-preference",
      "only-managed",
      "--no-install-project",
      "--no-dev",
    ],
  ]);
});

test("the runtime receipt detects dependency input drift without invoking uv", async (t) => {
  const { paths } = await fixture(t);
  await mkdir(paths.local, { recursive: true });
  await writeFile(paths.receipt, `${JSON.stringify(await runtimeFingerprint(paths))}\n`);
  await verifyRuntimeReceipt(paths);
  await writeFile(
    join(paths.tools, "pyproject.toml"),
    '[project]\nname = "fixture"\nversion = "0.0.1"\n',
  );
  await assert.rejects(verifyRuntimeReceipt(paths), /dependency inputs changed/);
});

test("the process-lifetime writer lock rejects a second writer and reaps stale owners", async (t) => {
  const { paths } = await fixture(t);
  const release = await acquireWriterLock(paths);
  await assert.rejects(acquireWriterLock(paths), /another writable MemPalace process/);
  await release();

  await mkdir(paths.lock);
  await writeFile(join(paths.lock, "owner.json"), '{"pid":2147483647}\n');
  const releaseRecovered = await acquireWriterLock(paths);
  await releaseRecovered();
});

test("Codex exposes exactly the reviewed project MCP allowlist", async () => {
  assert.deepEqual(await readCodexTools(pathsFor(repositoryRoot)), allowedTools);
  const config = await readFile(join(repositoryRoot, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(config, /^cwd\s*=/m);
  assert.match(config, /process\.cwd\(\)/);
  assert.match(config, /path\.join\(root,"scripts","mempalace\.mjs"\)/);
  for (const tool of [
    "mempalace_delete_drawer",
    "mempalace_delete_by_source",
    "mempalace_sync",
    "mempalace_mine",
    "mempalace_hook_settings",
    "mempalace_event_wait",
  ]) {
    assert.equal(config.includes(tool), false, `${tool} must not be exposed`);
  }
});

test("the checked-in mining policy excludes secrets, task context, and generated data", async (t) => {
  const { root, paths } = await fixture(t);
  const template = await readFile(
    join(repositoryRoot, "tools", "mempalace", "mempalace.template.yaml"),
    "utf8",
  );
  await writeFile(join(paths.tools, "mempalace.template.yaml"), template);
  await writeFile(join(root, "mempalace.yaml"), template);
  await verifyMiningPolicy(paths);
  for (const pattern of requiredExcludePatterns) {
    assert.equal(template.includes(`  - "${pattern}"`), true);
  }
  await writeFile(
    join(root, "mempalace.yaml"),
    template.replace(/  - "\.env\*"\r?\n/, ""),
  );
  await assert.rejects(verifyMiningPolicy(paths), /required mining exclusion/);
});

test("the project mining adapter applies root exclusions before narrowing a subtree", async () => {
  const source = await readFile(
    join(repositoryRoot, "tools", "mempalace", "project_mine.py"),
    "utf8",
  );
  assert.match(source, /scan_project\(\s*str\(root\)/);
  assert.match(source, /exclude_patterns=config\.get\("exclude_patterns", \[\]\)/);
  assert.match(source, /if target in path\.parents/);
  assert.doesNotMatch(source, /scan_project\(\s*str\(target\)/);
});

test("MCP startup fails before invoking a dependency when setup has not run", async (t) => {
  const { paths } = await fixture(t);
  let invoked = false;
  await assert.rejects(
    startMcp(paths, [], {
      runner: async () => {
        invoked = true;
      },
    }),
    /runtime receipt is missing/,
  );
  assert.equal(invoked, false);
});

test("fake MCP proves a second writable launcher exits nonzero", async (t) => {
  const { root, paths } = await fixture(t);
  await initializeFixture(paths);
  const fakeExecutable = join(root, "fake-mcp");
  await writeFile(fakeExecutable, "fake");
  let allowFirstToExit;
  let firstStarted;
  const started = new Promise((resolveStarted) => (firstStarted = resolveStarted));
  const holdFirst = new Promise((resolveExit) => (allowFirstToExit = resolveExit));
  const fakeRunner = async (executable) => {
    assert.equal(executable, fakeExecutable);
    firstStarted();
    await holdFirst;
  };
  const options = {
    command: { executable: fakeExecutable, args: [] },
    runner: fakeRunner,
    skipRuntimeCheck: true,
  };

  const first = startMcp(paths, [], options);
  await started;
  await assert.rejects(
    startMcp(paths, [], options),
    /another writable MemPalace process is active/,
  );
  allowFirstToExit();
  await first;
});
