/**
 * Shared trigger context for every workflow automation run.
 *
 * An automation thread owns one canonical CLI session, so run N resumes the
 * conversation history of runs 1..N-1. The only facts that distinguish the
 * current run from earlier ones are the trigger identity and the event payload,
 * and both live outside the conversation, so the run has to be told.
 *
 * Two placements, one string: `workflowAutomationPrompt` puts the trigger on the
 * visible user turn (the newest turn, and what the user reads in chat), and
 * `workflowAutomationAppendSystemPrompt` repeats it next to the event payload.
 * Every trigger line carries an identifier that is unique per firing, so a
 * resumed session self-labels which round each turn belongs to.
 *
 * These prompts state facts only. Behavioral instructions belong in the
 * workflow's own skill, and diagnostic guidance belongs in the output of the
 * command that diagnoses.
 */
export interface WorkflowAutomationContext {
  readonly workflowName: string;
  /**
   * One line naming what fired this run, including an identifier that is unique
   * to this firing (delivery id, message id, event id, or fire timestamp).
   */
  readonly trigger: string;
  /** Facts about what the event payload does and does not carry. */
  readonly notes?: readonly string[];
  readonly event: Readonly<Record<string, unknown>>;
}

/**
 * The visible user turn. Without the trigger line, consecutive firings of the
 * same automation produce byte-identical user turns.
 */
export function workflowAutomationPrompt(args: {
  readonly workflowName: string;
  readonly trigger: string;
}): string {
  return [`/${args.workflowName}`, `Trigger: ${args.trigger}`].join("\n");
}

export function workflowAutomationAppendSystemPrompt(
  context: WorkflowAutomationContext,
): string {
  return [
    "# Current context",
    `Run created by workflow automation "${context.workflowName}".`,
    `Trigger: ${context.trigger}`,
    `Procedure: skill "${context.workflowName}".`,
    "Output destination: this web chat thread, read by the user.",
    ...(context.notes ?? []),
    "",
    "# This run's event",
    JSON.stringify(context.event, null, 2),
  ].join("\n");
}
