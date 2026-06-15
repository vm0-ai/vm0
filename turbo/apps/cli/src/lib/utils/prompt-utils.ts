import { readFileSync } from "node:fs";
import prompts from "prompts";

/**
 * Check if the current environment supports interactive prompts
 * Returns true if stdout is a TTY (interactive terminal)
 */
export function isInteractive(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Read text piped on stdin, if any.
 *
 * `process.stdin.isTTY` is `true` only for an interactive terminal and
 * `undefined` when stdin is piped/redirected or there is no TTY context
 * (e.g. a test runner), so we guard with `!isTTY` rather than `=== false`
 * — the latter never matches the piped case and silently drops the input.
 *
 * Returns the trimmed piped text, or `undefined` when stdin is an
 * interactive terminal, unreadable, or empty.
 */
export function readPipedStdin(): string | undefined {
  if (process.stdin.isTTY) {
    return undefined;
  }

  try {
    const piped = readFileSync("/dev/stdin", "utf8").trim();
    return piped.length > 0 ? piped : undefined;
  } catch {
    // stdin not readable (e.g. test runner with no piped input);
    // treat as no piped input.
    return undefined;
  }
}

/**
 * Prompt for text input with optional default value
 * @param message - The prompt message
 * @param initial - Optional default value
 * @param validate - Optional validation function
 * @returns The user's input, or undefined if cancelled or non-interactive
 */
export async function promptText(
  message: string,
  initial?: string,
  validate?: (value: string) => boolean | string,
): Promise<string | undefined> {
  // In non-interactive mode, return undefined immediately
  if (!isInteractive()) {
    return undefined;
  }

  const response = await prompts(
    {
      type: "text",
      name: "value",
      message,
      initial,
      validate,
    },
    {
      onCancel: () => {
        // Return undefined on Ctrl+C
        return false;
      },
    },
  );

  return response.value;
}

/**
 * Prompt for yes/no confirmation
 * @param message - The prompt message
 * @param initial - Default value (true = yes, false = no)
 * @returns true if confirmed, false if declined, undefined if cancelled or non-interactive
 */
export async function promptConfirm(
  message: string,
  initial = true,
): Promise<boolean | undefined> {
  // In non-interactive mode, return undefined immediately
  if (!isInteractive()) {
    return undefined;
  }

  const response = await prompts(
    {
      type: "confirm",
      name: "value",
      message,
      initial,
    },
    {
      onCancel: () => {
        return false;
      },
    },
  );

  return response.value;
}

/**
 * Prompt for password/secret input (masked)
 * @param message - The prompt message
 * @returns The user's input, or undefined if cancelled or non-interactive
 */
export async function promptPassword(
  message: string,
): Promise<string | undefined> {
  // In non-interactive mode, return undefined immediately
  if (!isInteractive()) {
    return undefined;
  }

  const response = await prompts(
    {
      type: "password",
      name: "value",
      message,
    },
    {
      onCancel: () => {
        return false;
      },
    },
  );

  return response.value;
}
