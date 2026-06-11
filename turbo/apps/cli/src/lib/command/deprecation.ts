import chalk from "chalk";

/**
 * Print a one-line deprecation notice to stderr pointing at the replacement
 * command. Deprecated commands keep working unchanged; the notice never goes
 * to stdout so scripted consumers of the data output are unaffected.
 */
export function printDeprecationNotice(replacement: string): void {
  console.error(chalk.yellow(`⚠ deprecated: use \`${replacement}\``));
}
