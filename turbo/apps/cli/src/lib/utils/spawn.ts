import { spawn, type SpawnOptions } from "child_process";
import type { ChildProcess } from "child_process";

/**
 * Spawn a child process with safe Windows shell handling.
 *
 * On Windows, `shell: true` is required to resolve `.cmd` extensions for
 * commands like `npm`, `pnpm`, etc. On other platforms, shell is disabled
 * to avoid unnecessary shell interpretation. Commands passed to this
 * function must be hardcoded strings (not user input), and arguments
 * must use array form to prevent shell injection.
 *
 * nosemgrep: spawn-shell-true, detect-child-process -- shell only on Windows; callers pass hardcoded command names
 */
export function safeSpawn(
  command: string,
  args: string[],
  options?: Omit<SpawnOptions, "shell">,
): ChildProcess {
  const isWindows = process.platform === "win32";
  const resolvedCommand = isWindows ? `${command}.cmd` : command;

  return spawn(resolvedCommand, args, {
    ...options,
    shell: isWindows,
  });
}
