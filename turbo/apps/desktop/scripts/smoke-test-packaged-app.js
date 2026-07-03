const { spawn } = require("node:child_process");
const fs = require("node:fs");

const { packagedAppPaths } = require("./packaged-app-paths");

const READY_MARKER = "[smoke-test] desktop main ready";
const LAUNCH_TIMEOUT_MS = 60_000;

if (process.platform !== "darwin") {
  throw new Error("Packaged desktop smoke tests are only supported on macOS.");
}

const { executablePath, mainBundlePath, mcpBundlePath } = packagedAppPaths(
  process.env.VM0_DESKTOP_PLATFORM_URL,
);

if (!fs.existsSync(executablePath)) {
  throw new Error(`Packaged app executable was not found at ${executablePath}`);
}

if (!fs.existsSync(mcpBundlePath)) {
  throw new Error(
    `Packaged filesystem MCP bundle was not found at ${mcpBundlePath}`,
  );
}

function assertNoUnbundledRequires(bundlePath, bundle, prefixes, guidance) {
  for (const prefix of prefixes) {
    for (const unbundledRequire of [
      `require("${prefix}`,
      `require('${prefix}`,
    ]) {
      if (bundle.includes(unbundledRequire)) {
        throw new Error(
          `Packaged bundle contains an unbundled require (${unbundledRequire}...) in ${bundlePath}. ${guidance}`,
        );
      }
    }
  }
}

function assertNoUnbundledEsmImports(bundlePath, bundle, prefixes, guidance) {
  const lines = bundle.split(/\r?\n/);
  for (const prefix of prefixes) {
    for (const importSpecifier of [`"${prefix}`, `'${prefix}`]) {
      const lineIndex = lines.findIndex((line) => {
        const trimmed = line.trimStart();
        return (
          trimmed.startsWith("import ") && trimmed.includes(importSpecifier)
        );
      });
      if (lineIndex !== -1) {
        throw new Error(
          `Packaged bundle contains an unbundled import (${importSpecifier}...) in ${bundlePath}:${lineIndex + 1}. ${guidance}`,
        );
      }
    }
  }
}

const mainBundle = fs.readFileSync(mainBundlePath, "utf8");
assertNoUnbundledRequires(
  mainBundlePath,
  mainBundle,
  ["@vm0/", "@modelcontextprotocol/sdk/"],
  "These packages must be bundled via tsup noExternal; see tsup.electron.config.js.",
);
console.log(`Main bundle has no unbundled requires: ${mainBundlePath}`);

const mcpBundle = fs.readFileSync(mcpBundlePath, "utf8");
const unbundledMcpPrefixes = ["@modelcontextprotocol/sdk"];
assertNoUnbundledRequires(
  mcpBundlePath,
  mcpBundle,
  unbundledMcpPrefixes,
  "These packages must be bundled via tsup noExternal; see tsup.mcp-filesystem.config.js.",
);
assertNoUnbundledEsmImports(
  mcpBundlePath,
  mcpBundle,
  unbundledMcpPrefixes,
  "These packages must be bundled via tsup noExternal; see tsup.mcp-filesystem.config.js.",
);
console.log(
  `Filesystem MCP bundle has no unbundled SDK imports: ${mcpBundlePath}`,
);

const child = spawn(executablePath, [], {
  env: { ...process.env, VM0_DESKTOP_SMOKE_TEST: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill("SIGKILL");
}, LAUNCH_TIMEOUT_MS);

child.on("close", (code, signal) => {
  clearTimeout(timeout);

  const succeeded = code === 0 && stdout.includes(READY_MARKER);
  if (succeeded) {
    console.log(`Packaged app launched and reported ready: ${executablePath}`);
    return;
  }

  console.error(
    signal === "SIGKILL"
      ? `Packaged app did not report ready within ${LAUNCH_TIMEOUT_MS}ms`
      : `Packaged app exited with code ${code} (signal ${signal}) before reporting ready`,
  );
  console.error(`--- stdout ---\n${stdout}`);
  console.error(`--- stderr ---\n${stderr}`);
  process.exitCode = 1;
});
