import prompts from "prompts";

/**
 * Prompt for text input with optional default value
 * @param message - The prompt message
 * @param initial - Optional default value
 * @param validate - Optional validation function
 * @returns The user's input, or undefined if cancelled
 */
export async function promptText(
  message: string,
  initial?: string,
  validate?: (value: string) => boolean | string,
): Promise<string | undefined> {
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
 * @returns true if confirmed, false if declined, undefined if cancelled
 */
export async function promptConfirm(
  message: string,
  initial = true,
): Promise<boolean | undefined> {
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
