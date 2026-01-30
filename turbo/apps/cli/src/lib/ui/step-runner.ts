import chalk from "chalk";

/**
 * Context provided to step execution functions.
 * All output is cleared when the step completes.
 */
export interface StepContext {
  /** Print connector line "│" */
  connector(): void;

  /** Print detail line "│ message" */
  detail(message: string): void;

  /**
   * Execute a prompt function.
   * The prompt and its output will be cleared when step completes.
   */
  prompt<T>(promptFn: () => Promise<T | undefined>): Promise<T | undefined>;
}

/**
 * Step runner for orchestrating multi-step CLI flows.
 * Handles step lifecycle, output tracking, and clearing.
 */
export interface StepRunner {
  /** Execute a step with automatic clearing on completion */
  step(label: string, fn: (ctx: StepContext) => Promise<void>): Promise<void>;

  /** Execute final step (no connector line after completion) */
  finalStep(
    label: string,
    fn: (ctx: StepContext) => Promise<void>,
  ): Promise<void>;
}

interface CompletedStep {
  label: string;
  failed: boolean;
}

/**
 * Options for creating a step runner.
 */
interface StepRunnerOptions {
  /** Whether terminal supports ANSI sequences (default: true) */
  interactive?: boolean;
  /** Optional header function to call before redrawing steps */
  header?: () => void;
}

/**
 * Creates a step runner for CLI progress display.
 *
 * In interactive mode:
 * - Steps show "○ label" when starting
 * - All sub-content (details, prompts) is tracked
 * - On completion, screen is cleared and all completed steps are redrawn
 * - Only completed step indicators remain visible
 *
 * In non-interactive mode:
 * - No ANSI clearing (would corrupt piped output)
 * - All output remains visible
 *
 * @param options - Configuration options or boolean for interactive mode
 */
export function createStepRunner(
  options: StepRunnerOptions | boolean = true,
): StepRunner {
  // Handle legacy boolean parameter
  const opts: StepRunnerOptions =
    typeof options === "boolean" ? { interactive: options } : options;
  const interactive = opts.interactive ?? true;
  const headerFn = opts.header;
  // Track completed steps for redrawing after clear
  const completedSteps: CompletedStep[] = [];

  /**
   * Clear screen and redraw all completed steps.
   */
  function redrawCompletedSteps(isFinal: boolean): void {
    // Clear entire screen and move cursor to top
    process.stdout.write("\x1b[2J\x1b[H");

    // Redraw header if provided
    if (headerFn) {
      console.log();
      headerFn();
      console.log();
    }

    // Redraw all completed steps
    for (const [i, step] of completedSteps.entries()) {
      if (step.failed) {
        console.log(chalk.red(`✗ ${step.label}`));
      } else {
        console.log(chalk.green(`● ${step.label}`));
      }

      // Print connector line between steps (not after the last one if final)
      const isLastStep = i === completedSteps.length - 1;
      if (!isLastStep || !isFinal) {
        console.log(chalk.dim("│"));
      }
    }
  }

  /**
   * Execute a step with the given label and function.
   * @param label - Step name to display
   * @param fn - Async function containing step logic
   * @param isFinal - If true, no connector line after completion
   */
  async function executeStep(
    label: string,
    fn: (ctx: StepContext) => Promise<void>,
    isFinal: boolean,
  ): Promise<void> {
    let stepFailed = false;

    // Print step header
    console.log(chalk.yellow(`○ ${label}`));

    // Create step context
    const ctx: StepContext = {
      connector(): void {
        console.log(chalk.dim("│"));
      },

      detail(message: string): void {
        console.log(`${chalk.dim("│")} ${message}`);
      },

      async prompt<T>(
        promptFn: () => Promise<T | undefined>,
      ): Promise<T | undefined> {
        return await promptFn();
      },
    };

    // Execute step function
    try {
      await fn(ctx);
    } catch (error) {
      stepFailed = true;
      throw error;
    } finally {
      // Record completed step
      completedSteps.push({ label, failed: stepFailed });

      // In interactive mode, clear and redraw
      if (interactive) {
        redrawCompletedSteps(isFinal);
      } else {
        // Non-interactive: just print final status
        if (stepFailed) {
          console.log(chalk.red(`✗ ${label}`));
        } else {
          console.log(chalk.green(`● ${label}`));
        }
        if (!isFinal) {
          console.log(chalk.dim("│"));
        }
      }
    }
  }

  return {
    async step(
      label: string,
      fn: (ctx: StepContext) => Promise<void>,
    ): Promise<void> {
      await executeStep(label, fn, false);
    },

    async finalStep(
      label: string,
      fn: (ctx: StepContext) => Promise<void>,
    ): Promise<void> {
      await executeStep(label, fn, true);
    },
  };
}
