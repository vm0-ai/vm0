import chalk from "chalk";

export type StepStatus = "pending" | "in-progress" | "completed" | "failed";

export interface Step {
  label: string;
  status: StepStatus;
}

const STATUS_SYMBOLS: Record<StepStatus, string> = {
  completed: "●",
  "in-progress": "◐",
  pending: "○",
  failed: "✗",
};

function getStatusColor(status: StepStatus): (text: string) => string {
  switch (status) {
    case "completed":
      return chalk.green;
    case "in-progress":
      return chalk.yellow;
    case "failed":
      return chalk.red;
    case "pending":
    default:
      return chalk.dim;
  }
}

/**
 * Renders a vertical progress line with steps
 * @param steps - Array of steps with labels and statuses
 */
export function renderProgressLine(steps: Step[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    const symbol = STATUS_SYMBOLS[step.status];
    const color = getStatusColor(step.status);

    console.log(color(`${symbol} ${step.label}`));

    if (i < steps.length - 1) {
      console.log(chalk.dim("│"));
    }
  }
}

/**
 * Creates a progress tracker for the onboard flow
 */
export function createOnboardProgress(): {
  steps: Step[];
  render: () => void;
  update: (index: number, status: StepStatus) => void;
} {
  const steps: Step[] = [
    { label: "Authentication", status: "pending" },
    { label: "Model Provider Setup", status: "pending" },
    { label: "Create Agent", status: "pending" },
    { label: "Claude Plugin Install", status: "pending" },
    { label: "Complete", status: "pending" },
  ];

  return {
    steps,
    render: () => renderProgressLine(steps),
    update: (index: number, status: StepStatus) => {
      const step = steps[index];
      if (step) {
        step.status = status;
      }
    },
  };
}
