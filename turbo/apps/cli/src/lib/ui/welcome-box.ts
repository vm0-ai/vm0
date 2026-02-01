import chalk from "chalk";

// Orange gradient colors (light to dark, top to bottom)
const gradientColors = [
  chalk.hex("#FFAB5E"), // Line 1 - lightest
  chalk.hex("#FF9642"), // Line 2
  chalk.hex("#FF8228"), // Line 3
  chalk.hex("#FF6D0A"), // Line 4
  chalk.hex("#E85D00"), // Line 5
  chalk.hex("#CC4E00"), // Line 6 - darkest
];

/**
 * VM0 ASCII art logo lines
 */
const vm0LogoLines = [
  "██╗   ██╗███╗   ███╗ ██████╗ ",
  "██║   ██║████╗ ████║██╔═████╗",
  "██║   ██║██╔████╔██║██║██╔██║",
  "╚██╗ ██╔╝██║╚██╔╝██║████╔╝██║",
  " ╚████╔╝ ██║ ╚═╝ ██║╚██████╔╝",
  "  ╚═══╝  ╚═╝     ╚═╝ ╚═════╝ ",
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
 * Renders the default VM0 welcome banner for onboarding
 */
export function renderOnboardWelcome(): void {
  renderVm0Banner();
  console.log(`  ${chalk.bold("Welcome to VM0!")}`);
  console.log(
    `  ${chalk.dim("Build agentic workflows using natural language.")}`,
  );
  console.log();
}
