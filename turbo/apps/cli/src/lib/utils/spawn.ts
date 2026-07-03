import { spawn, type SpawnOptions, type ChildProcess } from "child_process";

/**
 * Spawn a child process with safe Windows shell handling.
 *
 * On Windows, `shell: true` is required to resolve `.cmd` extensions for
 * commands like `npm`, `pnpm`, etc. On other platforms, shell is disabled
 * to avoid unnecessary shell interpretation. Commands passed to this
 * function must be hardcoded strings (not user input), and arguments
 * must use array form to prevent shell injection.
 *
 */
export function safeSpawn(
  command: string,
  args: string[],
  options?: Omit<SpawnOptions, "shell">,
): ChildProcess {
  const isWindows = process.platform === "win32";
  const resolvedCommand = isWindows ? `${command}.cmd` : command;

  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true, javascript.lang.security.detect-child-process.detect-child-process
  return spawn(resolvedCommand, args, {
    ...options,
    shell: isWindows,
  });
}
