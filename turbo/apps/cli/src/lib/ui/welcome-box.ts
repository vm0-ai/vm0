import chalk from "chalk";

/**
 * Renders a welcome box with Unicode borders
 * @param lines - Array of text lines to display inside the box
 * @param width - Optional fixed width (defaults to auto-fit based on content)
 */
export function renderWelcomeBox(lines: string[], width?: number): void {
  const maxLineLength = Math.max(...lines.map((line) => line.length));
  const boxWidth = width ?? maxLineLength + 4;
  const innerWidth = boxWidth - 2;

  const horizontalLine = "─".repeat(innerWidth);
  const topBorder = `┌${horizontalLine}┐`;
  const bottomBorder = `└${horizontalLine}┘`;

  console.log(chalk.cyan(topBorder));

  for (const line of lines) {
    const padding = innerWidth - line.length;
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    const centeredLine = " ".repeat(leftPad) + line + " ".repeat(rightPad);
    console.log(chalk.cyan("│") + centeredLine + chalk.cyan("│"));
  }

  console.log(chalk.cyan(bottomBorder));
}

/**
 * Renders the default VM0 welcome box for onboarding
 */
export function renderOnboardWelcome(): void {
  renderWelcomeBox([
    "",
    "Welcome to VM0!",
    "",
    "Let's create your first agent.",
    "",
  ]);
}
