#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const upstreamCommit = "13de004783d21de631c4c85bf4803a4866de55e4";
const windowsSha256 =
  "d4aa19539a5a28d350598574e93ed06fcb3d571c7657236c069c3371a153552d";
const windowsUrl =
  `https://raw.githubusercontent.com/killop/codedb-mcp/${upstreamCommit}` +
  "/skills/codedb-mcp/assets/codebase-mcp.exe";
const expectedTools = [
  "codedb_graph_query",
  "codedb_outline",
  "codedb_read",
  "codedb_status",
  "codedb_symbol",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codedbDir = join(repoRoot, ".codedb-mcp");
const configPath = join(codedbDir, "codedb-mcp.toml");
const binaryPath = join(
  codedbDir,
  "bin",
  process.platform === "win32" ? "codebase-mcp.exe" : "codebase-mcp",
);

function fail(message) {
  console.error(`codedb-mcp: ${message}`);
  process.exitCode = 1;
}

async function sha256(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function installWindowsBinary() {
  if (await fileExists(binaryPath)) {
    const actualSha256 = await sha256(binaryPath);
    if (actualSha256 !== windowsSha256) {
      throw new Error(
        `refusing to run ${binaryPath}: SHA-256 is ${actualSha256}, expected ${windowsSha256}`,
      );
    }
    return;
  }

  await mkdir(dirname(binaryPath), { recursive: true });
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const downloadPath = `${binaryPath}.${process.pid}.${attempt}.download`;
    console.error(
      `codedb-mcp: downloading pinned runtime ${upstreamCommit.slice(0, 12)} ` +
        `(attempt ${attempt}/3)`,
    );

    try {
      const response = await fetch(windowsUrl, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`download failed with HTTP ${response.status}`);
      }
      await pipeline(response.body, createWriteStream(downloadPath, { flags: "wx" }));

      const actualSha256 = await sha256(downloadPath);
      if (actualSha256 !== windowsSha256) {
        throw new Error(
          `downloaded SHA-256 is ${actualSha256}, expected ${windowsSha256}`,
        );
      }

      if (await fileExists(binaryPath)) {
        const installedSha256 = await sha256(binaryPath);
        if (installedSha256 !== windowsSha256) {
          throw new Error(
            `existing SHA-256 is ${installedSha256}, expected ${windowsSha256}`,
          );
        }
        return;
      }

      await rename(downloadPath, binaryPath);
      await chmod(binaryPath, 0o755);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1000));
      }
    } finally {
      await rm(downloadPath, { force: true });
    }
  }

  throw lastError;
}

async function ensureRuntime() {
  if (!(await fileExists(configPath))) {
    throw new Error(`missing project configuration: ${configPath}`);
  }
  if (process.platform !== "win32") {
    throw new Error(
      "the pinned upstream package only distributes codebase-mcp.exe; " +
        "this project bootstrap currently supports Windows only",
    );
  }
  await installWindowsBinary();
}

function runBinary(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binaryPath, ["--config", configPath, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) {
        rejectRun(new Error(`runtime stopped by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`runtime exited with code ${code ?? "unknown"}`));
        return;
      }
      resolveRun();
    });
  });
}

async function runMcpSmoke() {
  const smokeDir = join(codedbDir, "smoke");
  const smokeId = `${process.pid}-${Date.now()}`;
  const inputPath = join(smokeDir, `${smokeId}.input.jsonl`);
  const outputPath = join(smokeDir, `${smokeId}.output.jsonl`);
  const errorPath = join(smokeDir, `${smokeId}.stderr.log`);
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "multica-codedb-smoke", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "codedb_status", arguments: {} },
    },
  ];

  await mkdir(smokeDir, { recursive: true });
  await writeFile(inputPath, `${messages.map(JSON.stringify).join("\n")}\n`);
  const input = await open(inputPath, "r");
  const output = await open(outputPath, "w");
  const diagnostics = await open(errorPath, "w");

  try {
    await new Promise((resolveSmoke, rejectSmoke) => {
      const child = spawn(binaryPath, ["--config", configPath, "mcp", repoRoot], {
        cwd: repoRoot,
        env: process.env,
        stdio: [input.fd, output.fd, diagnostics.fd],
        windowsHide: true,
      });
      const timeout = setTimeout(() => {
        child.kill();
        rejectSmoke(new Error("MCP smoke test timed out after 120 seconds"));
      }, 120000);

      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectSmoke(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (signal) {
          rejectSmoke(new Error(`MCP server stopped by signal ${signal}`));
        } else if (code !== 0) {
          rejectSmoke(new Error(`MCP server exited with code ${code ?? "unknown"}`));
        } else {
          resolveSmoke();
        }
      });
    });
  } catch (error) {
    const stderr = (await readFile(errorPath, "utf8")).trim();
    throw new Error(stderr ? `${error.message}; stderr: ${stderr}` : error.message);
  } finally {
    await Promise.all([input.close(), output.close(), diagnostics.close()]);
  }

  try {
    const responses = (await readFile(outputPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const initialized = responses.find((message) => message.id === 1);
    const listed = responses.find((message) => message.id === 2);
    const called = responses.find((message) => message.id === 3);

    if (!initialized?.result?.protocolVersion) {
      throw new Error("MCP initialize response is missing");
    }
    console.log(`MCP protocol: ${initialized.result.protocolVersion}`);

    const toolNames = listed?.result?.tools?.map((tool) => tool.name).sort();
    if (!toolNames || JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
      throw new Error(`unexpected MCP tool set: ${toolNames?.join(", ") ?? "missing"}`);
    }
    console.log(`MCP tools: ${toolNames.join(", ")}`);

    if (!called || called.error || called.result?.isError) {
      throw new Error(`codedb_status failed: ${JSON.stringify(called)}`);
    }
    const status = called.result.content.map((item) => item.text ?? "").join("\n");
    const files = Number(status.match(/files:\s*(\d+)/)?.[1]);
    const scan = status.match(/scan:\s*([^\n]+)/)?.[1];
    console.log(`codedb_status: files=${files}, scan=${scan ?? "unknown"}`);
    if (!Number.isInteger(files) || files <= 0 || scan !== "ready") {
      throw new Error(`unexpected codedb_status response: ${status}`);
    }
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(outputPath, { force: true }),
      rm(errorPath, { force: true }),
    ]);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/codedb-mcp.mjs <command>

Commands:
  install   Download and verify the pinned Windows runtime
  index     Build or refresh the project-local index
  status    Read index health and coverage
  smoke     Verify MCP initialization, tool discovery, and codedb_status
  mcp       Start the stdio MCP server (used by Codex and Claude Code)
  version   Print the pinned runtime version`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  await ensureRuntime();

  switch (command) {
    case "install":
      await runBinary(["--version"]);
      break;
    case "index":
      await runBinary(["index", repoRoot, ...rest]);
      break;
    case "status":
      await runBinary(["--root", repoRoot, "tool", "codedb_status", "{}", ...rest]);
      break;
    case "smoke":
      await runMcpSmoke();
      break;
    case "mcp":
      await runBinary(["mcp", repoRoot, ...rest]);
      break;
    case "version":
      await runBinary(["--version"]);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
