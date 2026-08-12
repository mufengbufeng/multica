import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await readFile(join(repoRoot, ".codex", "config.toml"), "utf8");
const codedbSection = config.match(
  /\[mcp_servers\.codedb-mcp\]([\s\S]*?)(?=\r?\n\[|$)/,
)?.[1];
const bootstrap = codedbSection?.match(
  /args\s*=\s*\[\s*"--eval",\s*'([^']+)',\s*\]/,
)?.[1];

assert.ok(bootstrap, "could not read the codedb-mcp bootstrap from .codex/config.toml");

const importExpression =
  'import(url.pathToFileURL(script).href).catch((error)=>{console.error(error);process.exit(1)});';
assert.ok(bootstrap.includes(importExpression), "codedb-mcp import expression changed");
const testableBootstrap = bootstrap.replace(
  importExpression,
  "captureImport(url.pathToFileURL(script).href);",
);

const hostRequire = createRequire(import.meta.url);
const allowedModules = new Set(["node:fs", "node:path", "node:url"]);
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

async function createGitRoot(parent, name, { launcher = true } = {}) {
  const root = join(parent, name);
  await mkdir(join(root, ".git"), { recursive: true });
  if (launcher) {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "codedb-mcp.mjs"), "export {};\n");
  }
  return root;
}

async function runBootstrap(cwd, args = []) {
  const state = {
    argv: [process.execPath, ...args],
    cwd: resolve(cwd),
    imported: null,
    stderr: [],
  };
  const processMock = {
    get argv() {
      return state.argv;
    },
    set argv(value) {
      state.argv = value;
    },
    cwd: () => state.cwd,
    chdir: (path) => {
      state.cwd = resolve(path);
    },
    exit: (code) => {
      const error = new Error(`process.exit(${code})`);
      error.exitCode = code;
      throw error;
    },
  };
  const script = new Script(testableBootstrap, {
    filename: ".codex/config.toml#codedb-mcp",
  });

  try {
    await script.runInNewContext({
      console: {
        error: (...values) => state.stderr.push(values.map(String).join(" ")),
      },
      process: processMock,
      captureImport: (specifier) => {
        state.imported = specifier;
      },
      require: (specifier) => {
        if (!allowedModules.has(specifier)) {
          throw new Error(`unexpected require: ${specifier}`);
        }
        return hostRequire(specifier);
      },
    });
    return { ...state, status: 0 };
  } catch (error) {
    if (Number.isInteger(error.exitCode)) {
      return { ...state, status: error.exitCode };
    }
    throw error;
  }
}

test("starts the project launcher from the Git root", async () => {
  const temp = await mkdtemp(join(tmpdir(), "multica-codedb-root-"));
  try {
    const root = await createGitRoot(temp, "repo");

    const result = await runBootstrap(root);

    const launcher = resolve(root, "scripts", "codedb-mcp.mjs");
    assert.equal(result.status, 0, result.stderr.join("\n"));
    assert.equal(result.cwd, resolve(root));
    assert.equal(result.imported, pathToFileURL(launcher).href);
    assert.deepEqual(Array.from(result.argv), [process.execPath, launcher, "mcp"]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("finds the same project launcher from a nested directory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "multica-codedb-nested-"));
  try {
    const root = await createGitRoot(temp, "repo");
    const nested = join(root, "apps", "web", "src");
    await mkdir(nested, { recursive: true });

    const result = await runBootstrap(nested);

    const launcher = resolve(root, "scripts", "codedb-mcp.mjs");
    assert.equal(result.status, 0, result.stderr.join("\n"));
    assert.equal(result.cwd, resolve(root));
    assert.equal(result.imported, pathToFileURL(launcher).href);
    assert.deepEqual(Array.from(result.argv), [process.execPath, launcher, "mcp"]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("fails at the nearest Git root when its launcher is missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "multica-codedb-boundary-"));
  try {
    const outer = await createGitRoot(temp, "outer");
    const inner = await createGitRoot(outer, "inner", { launcher: false });
    const nested = join(inner, "apps", "web");
    await mkdir(nested, { recursive: true });

    const result = await runBootstrap(nested);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr.join("\n"), /codedb-mcp: missing project launcher:/);
    assert.equal(result.imported, null, "must not import the outer project launcher");
    assert.equal(existsSync(join(outer, "scripts", "codedb-mcp.mjs")), true);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

test("passes mcp before any bootstrap arguments", async () => {
  const temp = await mkdtemp(join(tmpdir(), "multica-codedb-args-"));
  try {
    const root = await createGitRoot(temp, "repo");

    const result = await runBootstrap(root, ["--probe", "value"]);

    const launcher = resolve(root, "scripts", "codedb-mcp.mjs");
    assert.equal(result.status, 0, result.stderr.join("\n"));
    assert.deepEqual(Array.from(result.argv), [
      process.execPath,
      launcher,
      "mcp",
      "--probe",
      "value",
    ]);
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`${tests.length}/${tests.length} codedb Codex bootstrap tests passed`);
}
