import chalk from "chalk";

/**
 * Progressive progress tracker that reveals steps one at a time.
 * Steps are shown only when they start, and detail lines can be added
 * during execution. When a step completes, detail lines are cleared.
 */
export interface ProgressiveProgress {
  /** Start a new step (prints step line with ○) */
  startStep: (label: string) => void;
  /** Print a detail line (prefixed with │) */
  detail: (message: string) => void;
  /** Complete current step (clears details, prints ● with │ connector) */
  completeStep: () => void;
  /** Fail current step (clears details, prints ✗) */
  failStep: () => void;
  /** Mark as final step (no connector line after completion) */
  setFinalStep: () => void;
}

/**
 * Creates a progressive progress tracker for streaming-style output.
 * @param interactive - Whether to use ANSI escape sequences for cursor control
 */
export function createProgressiveProgress(
  interactive: boolean = true,
): ProgressiveProgress {
  let currentLabel = "";
  let detailLineCount = 0;
  let isFinalStep = false;

  const clearDetails = (): void => {
    if (!interactive || detailLineCount === 0) return;

    // Move cursor up to the step line (detailLineCount + 1)
    process.stdout.write(`\x1b[${detailLineCount + 1}A`);
    // Clear the step line
    process.stdout.write(`\x1b[K`);
  };

  const clearDetailLines = (): void => {
    if (!interactive) return;

    // We're now at the step line position, need to clear detail lines below
    // First, move down and clear each detail line
    for (let i = 0; i < detailLineCount; i++) {
      process.stdout.write(`\n\x1b[K`);
    }
    // Move back up to just below step line
    if (detailLineCount > 0) {
      process.stdout.write(`\x1b[${detailLineCount}A`);
    }
  };

  return {
    startStep: (label: string): void => {
      currentLabel = label;
      detailLineCount = 0;
      isFinalStep = false;
      console.log(chalk.yellow(`○ ${label}`));
    },

    detail: (message: string): void => {
      console.log(chalk.dim(`│ ${message}`));
      detailLineCount++;
    },

    completeStep: (): void => {
      if (interactive && detailLineCount > 0) {
        clearDetails();
      } else if (interactive) {
        // Just move up one line to overwrite the step line
        process.stdout.write(`\x1b[1A\x1b[K`);
      }

      // Print completed step
      console.log(chalk.green(`● ${currentLabel}`));

      if (interactive && detailLineCount > 0) {
        clearDetailLines();
      }

      // Print connector line (unless this is the final step)
      if (!isFinalStep) {
        console.log(chalk.dim("│"));
      }

      // Reset state
      currentLabel = "";
      detailLineCount = 0;
    },

    failStep: (): void => {
      if (interactive && detailLineCount > 0) {
        clearDetails();
      } else if (interactive) {
        process.stdout.write(`\x1b[1A\x1b[K`);
      }

      // Print failed step
      console.log(chalk.red(`✗ ${currentLabel}`));

      if (interactive && detailLineCount > 0) {
        clearDetailLines();
      }

      // Reset state
      currentLabel = "";
      detailLineCount = 0;
    },

    setFinalStep: (): void => {
      isFinalStep = true;
    },
  };
}
