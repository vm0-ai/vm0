import chalk from "chalk";

// Orange gradient colors (light to dark, top to bottom) - 8 colors for 8 lines
const gradientColors = [
  chalk.hex("#FFBF7A"), // Line 1 - lightest
  chalk.hex("#FFAB5E"), // Line 2
  chalk.hex("#FF9642"), // Line 3
  chalk.hex("#FF8228"), // Line 4
  chalk.hex("#FF6D0A"), // Line 5
  chalk.hex("#E85D00"), // Line 6
  chalk.hex("#CC4E00"), // Line 7
  chalk.hex("#B34400"), // Line 8 - darkest
];

/**
 * VM0 icon
 */
const vm0IconLines = [
  "     @@@@     ",
  "  @@@@@@@@@@  ",
  "#@@@@@@@@@@@@*",
  "#####@@@@  / *",
  "#######   /  *",
  "#######  /  **",
  "  ##### /***  ",
  "     ##**     ",
];

/**
 * VM0 ASCII art text lines
 */
const vm0TextLines = [
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
  for (let i = 0; i < vm0IconLines.length; i++) {
    const color =
      gradientColors[i] ?? gradientColors[gradientColors.length - 1];
    const icon = vm0IconLines[i];
    // Text lines are offset by 1 (centered vertically with icon)
    const text = vm0TextLines[i - 1] ?? "";
    console.log(`  ${color?.(icon)}   ${text ? color?.(text) : ""}`);
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
