import * as readline from "readline";

/**
 * Prompt user for yes/no confirmation
 * Returns true if user confirms (Y, y, yes, or empty), false otherwise
 *
 * @param message - The message to display
 * @returns Promise resolving to true if confirmed, false otherwise
 */
export async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (Y/n) `, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      // Default to yes if empty, or explicit yes
      resolve(normalized === "" || normalized === "y" || normalized === "yes");
    });
  });
}

/**
 * Check if running in an interactive terminal
 *
 * @returns true if stdin is a TTY (interactive terminal)
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}
