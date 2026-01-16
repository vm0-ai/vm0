import prompts from "prompts";

/**
 * Check if the current environment supports interactive prompts
 * Returns true if stdout is a TTY (interactive terminal)
 */
export function isInteractive(): boolean {
  return process.stdout.isTTY === true;
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
 * Choice option for select prompts
 */
interface SelectChoice<T> {
  title: string;
  value: T;
  description?: string;
}

/**
 * Prompt for selecting from a list of options
 * @param message - The prompt message
 * @param choices - Array of choices with title, value, and optional description
 * @param initial - Index of the default selection (0-based)
 * @returns The selected value, or undefined if cancelled or non-interactive
 */
export async function promptSelect<T>(
  message: string,
  choices: SelectChoice<T>[],
  initial?: number,
): Promise<T | undefined> {
  // In non-interactive mode, return undefined immediately
  if (!isInteractive()) {
    return undefined;
  }

  const response = await prompts(
    {
      type: "select",
      name: "value",
      message,
      choices,
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
