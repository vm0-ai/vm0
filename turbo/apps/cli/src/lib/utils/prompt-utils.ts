import prompts from "prompts";

/**
 * Check if the current environment supports interactive prompts
 * Returns true if stdout is a TTY (interactive terminal)
 */
export function isInteractive(): boolean {
  return process.stdout.isTTY === true;
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
