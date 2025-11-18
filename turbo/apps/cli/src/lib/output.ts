import chalk from "chalk";

export interface OutputOptions {
  json?: boolean;
  verbose?: boolean;
}

/**
 * Output success message
 */
export function success(message: string): void {
  console.log(chalk.green("✓"), message);
}

/**
 * Output error message
 */
export function error(message: string): void {
  console.error(chalk.red("✗"), message);
}

/**
 * Output info message
 */
export function info(message: string): void {
  console.log(chalk.blue("ℹ"), message);
}

/**
 * Output section heading
 */
export function heading(message: string): void {
  console.log();
  console.log(chalk.bold(message));
}

/**
 * Output JSON or formatted result
 */
export function outputResult(data: unknown, options: OutputOptions): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  }
}
