import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLocalAgentBackends,
  executeLocalAgentBackend,
  preflightLocalAgentBackend,
} from "./desktop-local-agent-runtime";

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoots = [];
});

function createTempRoot(): string {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desktop-runtime-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function createExecutable(
  directory: string,
  name: string,
  script: string,
): string {
  mkdirSync(directory, { recursive: true });
  const executablePath = path.join(directory, name);
  writeFileSync(executablePath, script, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function codexScript(loginExitCode: number): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli test"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  exit ${loginExitCode}
fi
if [ "$1" = "exec" ]; then
  echo "ran $*"
  exit 0
fi
echo "unexpected $*" >&2
exit 2
`;
}

describe("desktop local agent runtime", () => {
  it("finds Codex in a common install directory when GUI PATH is limited", async () => {
    const tempRoot = createTempRoot();
    const binDir = path.join(tempRoot, "opt/homebrew/bin");
    const codexPath = createExecutable(binDir, "codex", codexScript(0));

    const probes = await detectLocalAgentBackends({
      env: {
        HOME: tempRoot,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      commonExecutableDirectories: [binDir],
    });

    expect(probes).toEqual([
      expect.objectContaining({
        backend: "codex",
        command: "codex",
        available: true,
        executablePath: codexPath,
        version: "codex-cli test",
      }),
      expect.objectContaining({
        backend: "claude-code",
        command: "claude",
        available: false,
        errorMessage: "Claude Code not found",
      }),
    ]);
  });

  it("preflights and executes Codex using the resolved executable path", async () => {
    const tempRoot = createTempRoot();
    const binDir = path.join(tempRoot, "opt/homebrew/bin");
    createExecutable(binDir, "codex", codexScript(0));

    const runtime = await preflightLocalAgentBackend("codex", {
      env: {
        HOME: tempRoot,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      commonExecutableDirectories: [binDir],
    });
    const result = await executeLocalAgentBackend({
      backend: "codex",
      prompt: "hello",
      workdir: tempRoot,
      permissionMode: "workspace-write",
      executablePath: runtime.executablePath,
      runtimePath: runtime.runtimePath,
    });

    expect(runtime.executablePath).toBe(path.join(binDir, "codex"));
    expect(result).toMatchObject({
      output: "ran exec --sandbox workspace-write hello",
      exitCode: 0,
    });
  });

  it("reports spawn ENOENT as an unhealthy backend", async () => {
    const tempRoot = createTempRoot();
    const result = await executeLocalAgentBackend({
      backend: "codex",
      prompt: "hello",
      workdir: tempRoot,
      permissionMode: "workspace-write",
      executablePath: path.join(tempRoot, "missing-codex"),
      runtimePath: tempRoot,
    });

    expect(result.exitCode).toBe(1);
    expect(result.backendHealthy).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("reports an unauthenticated Codex backend during preflight", async () => {
    const tempRoot = createTempRoot();
    const binDir = path.join(tempRoot, "opt/homebrew/bin");
    createExecutable(binDir, "codex", codexScript(1));

    await expect(
      preflightLocalAgentBackend("codex", {
        env: {
          HOME: tempRoot,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        commonExecutableDirectories: [binDir],
      }),
    ).rejects.toThrow("Codex not logged in");
  });
});
