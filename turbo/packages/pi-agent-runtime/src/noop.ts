import {
  ExecutionError,
  FileError,
} from "@earendil-works/pi-agent-core";

import type { ExecutionEnv, FileInfo, Result } from "./types";

interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function fileFailure<TValue>(): Result<TValue, FileError> {
  return {
    ok: false,
    error: new FileError(
      "not_supported",
      "Execution is unavailable; Pi edge turns hand off to the Sandbox",
    ),
  };
}

function shellFailure(): Result<ShellResult, ExecutionError> {
  return {
    ok: false,
    error: new ExecutionError(
      "shell_unavailable",
      "Shell execution requires Sandbox handoff",
    ),
  };
}

/**
 * Pi edge turns execute no tools: their `read` runs in the Sandbox after a
 * first-round handoff. Tools are still advertised to the first-round model
 * (so it can reach for the Sandbox), but the backing {@link ExecutionEnv} is
 * never exercised, so it is a no-op that reports every operation as
 * unavailable rather than materializing a filesystem.
 */
export function createPiNoopExecutionEnv(): ExecutionEnv {
  return {
    cwd: "/home/user/workspace",
    absolutePath: (path) => Promise.resolve({ ok: true, value: path }),
    joinPath: (parts) =>
      Promise.resolve({ ok: true, value: parts.join("/") }),
    readTextFile: () => Promise.resolve(fileFailure()),
    readTextLines: () => Promise.resolve(fileFailure()),
    readBinaryFile: () => Promise.resolve(fileFailure()),
    writeFile: () => Promise.resolve(fileFailure()),
    appendFile: () => Promise.resolve(fileFailure()),
    fileInfo: () => Promise.resolve(fileFailure<FileInfo>()),
    listDir: () => Promise.resolve(fileFailure()),
    canonicalPath: () => Promise.resolve(fileFailure()),
    exists: () => Promise.resolve(fileFailure<boolean>()),
    createDir: () => Promise.resolve(fileFailure()),
    remove: () => Promise.resolve(fileFailure()),
    createTempDir: () => Promise.resolve(fileFailure()),
    createTempFile: () => Promise.resolve(fileFailure()),
    exec: () => Promise.resolve(shellFailure()),
    cleanup: () => Promise.resolve(),
  };
}
