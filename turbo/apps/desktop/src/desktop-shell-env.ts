import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const RESOLVE_TIMEOUT_MS = 10_000;

interface ResolveLoginShellPathOptions {
  readonly shell?: string;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the user's login shell PATH. GUI apps on macOS/Linux inherit the
 * launchd/session environment whose PATH misses Homebrew and version-manager
 * directories, so commands like `npx` fail with ENOENT when spawned directly.
 *
 * Follows VS Code's shell environment resolution: run the login shell
 * interactively and have it execute this Electron binary as node to print
 * `process.env` as JSON between random marks, which keeps shell rc output
 * from corrupting the result. Returns null on Windows, timeout, or any
 * spawn/parse failure so callers can fall back to the current environment.
 */
export function resolveLoginShellPath(
  options: ResolveLoginShellPathOptions = {},
): Promise<string | null> {
  if (process.platform === "win32") {
    return Promise.resolve(null);
  }
  const shell =
    options.shell ??
    process.env.SHELL ??
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  const mark = randomBytes(6).toString("hex");
  const command = `'${process.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;

  return new Promise((resolve) => {
    const child = spawn(shell, ["-i", "-l", "-c", command], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    let settled = false;
    const settle = (value: string | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(null);
    }, timeoutMs);

    const buffers: Buffer[] = [];
    child.stdout.on("data", (buffer: Buffer) => {
      buffers.push(buffer);
    });
    child.on("error", () => {
      settle(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        return settle(null);
      }
      const raw = Buffer.concat(buffers).toString("utf8");
      const match = new RegExp(`${mark}({.*})${mark}`).exec(raw);
      const json = match?.[1];
      if (!json) {
        return settle(null);
      }
      try {
        const env: unknown = JSON.parse(json);
        const path =
          isRecord(env) && typeof env.PATH === "string" ? env.PATH.trim() : "";
        settle(path ? path : null);
      } catch {
        settle(null);
      }
    });
  });
}
