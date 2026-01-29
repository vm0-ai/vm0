import chalk from "chalk";

// Orange gradient colors (light to dark, top to bottom)
const gradientColors = [
  chalk.hex("#FF9650"), // Line 1 - lightest
  chalk.hex("#FF7832"), // Line 2
  chalk.hex("#FF7832"), // Line 3
  chalk.hex("#ED4E01"), // Line 4 - brand orange
  chalk.hex("#ED4E01"), // Line 5
  chalk.hex("#C83C00"), // Line 6 - darkest
];

/**
 * VM0 ASCII art logo lines
 */
const vm0LogoLines = [
  "██╗   ██╗███╗   ███╗ ██████╗",
  "██║   ██║████╗ ████║██╔═══██╗",
  "██║   ██║██╔████╔██║██║   ██║",
  "╚██╗ ██╔╝██║╚██╔╝██║██║   ██║",
  " ╚████╔╝ ██║ ╚═╝ ██║╚██████╔╝",
  "  ╚═══╝  ╚═╝     ╚═╝ ╚═════╝",
];

/**
 * Renders the VM0 ASCII art banner with orange gradient
 */
function renderVm0Banner(): void {
  console.log();
  for (let i = 0; i < vm0LogoLines.length; i++) {
    const color =
      gradientColors[i] ?? gradientColors[gradientColors.length - 1];
    console.log(`  ${color?.(vm0LogoLines[i])}`);
  }
  console.log();
}

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
 * Renders the default VM0 welcome banner for onboarding
 */
export function renderOnboardWelcome(): void {
  renderVm0Banner();
  console.log(`  ${chalk.bold("Welcome to VM0!")}`);
  console.log(`  ${chalk.dim("Let's create your first agent.")}`);
  console.log();
}
