import { ExecutionError, FileError } from "@earendil-works/pi-agent-core";

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
    absolutePath: (path) => {
      return Promise.resolve({ ok: true, value: path });
    },
    joinPath: (parts) => {
      return Promise.resolve({ ok: true, value: parts.join("/") });
    },
    readTextFile: () => {
      return Promise.resolve(fileFailure());
    },
    readTextLines: () => {
      return Promise.resolve(fileFailure());
    },
    readBinaryFile: () => {
      return Promise.resolve(fileFailure());
    },
    writeFile: () => {
      return Promise.resolve(fileFailure());
    },
    appendFile: () => {
      return Promise.resolve(fileFailure());
    },
    fileInfo: () => {
      return Promise.resolve(fileFailure<FileInfo>());
    },
    listDir: () => {
      return Promise.resolve(fileFailure());
    },
    canonicalPath: () => {
      return Promise.resolve(fileFailure());
    },
    exists: () => {
      return Promise.resolve(fileFailure<boolean>());
    },
    createDir: () => {
      return Promise.resolve(fileFailure());
    },
    remove: () => {
      return Promise.resolve(fileFailure());
    },
    createTempDir: () => {
      return Promise.resolve(fileFailure());
    },
    createTempFile: () => {
      return Promise.resolve(fileFailure());
    },
    exec: () => {
      return Promise.resolve(shellFailure());
    },
    cleanup: () => {
      return Promise.resolve();
    },
  };
}
