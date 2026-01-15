import prompts from "prompts";
import chalk from "chalk";

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
export interface SelectChoice<T> {
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

/**
 * Prompt for text input with a gray hint prefix in the default value.
 * The hint is displayed in gray/dim and is stripped from the result.
 *
 * Display: "Date (YYYY-MM-DD): tomorrow 2025-01-15"
 *                              ^^^^^^^^ (gray)
 *
 * - Tab: Autocompletes to initial value (hint + value), user can then edit
 * - Enter: Accepts input and strips hint prefix if present
 *
 * @param message - The prompt message
 * @param hint - The hint word to display in gray (e.g., "tomorrow")
 * @param initial - The actual value (e.g., "2025-01-15")
 * @param validate - Optional validation function (receives value without hint)
 * @returns The user's input without the hint, or undefined if cancelled
 */
export async function promptTextWithHint(
  message: string,
  hint: string,
  initial: string,
  validate?: (value: string) => boolean | string,
): Promise<string | undefined> {
  if (!isInteractive()) {
    return undefined;
  }

  // Create the display value with hint prefix
  const hintedInitial = `${hint} ${initial}`;

  const response = await prompts(
    {
      type: "text",
      name: "value",
      message,
      initial: hintedInitial,
      // Custom render to show hint in gray
      onRender(this: { msg: string; rendered: string; value: string }) {
        // If the current value starts with the hint, style it
        if (this.value.startsWith(hint + " ")) {
          const hintPart = hint + " ";
          const valuePart = this.value.slice(hintPart.length);
          this.rendered = chalk.dim(hintPart) + valuePart;
        }
      },
      // Validate after stripping hint
      validate: validate
        ? (value: string) => {
            const stripped = stripHintPrefix(value, hint);
            return validate(stripped);
          }
        : undefined,
      // Format the final value to strip hint
      format: (value: string) => stripHintPrefix(value, hint),
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
 * Strip hint prefix from a value if present
 */
function stripHintPrefix(value: string, hint: string): string {
  const prefix = hint + " ";
  if (value.startsWith(prefix)) {
    return value.slice(prefix.length);
  }
  return value;
}
