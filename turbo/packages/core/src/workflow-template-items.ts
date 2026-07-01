export interface WorkflowTemplateItem {
  readonly id: `workflow-template:${string}`;
  readonly title: string;
  readonly description: string;
  readonly promptGuidance: string;
}

export const WORKFLOW_TEMPLATE_ITEMS: readonly WorkflowTemplateItem[] = [
  {
    id: "workflow-template:auto-inbox-label",
    title: "Auto-inbox label",
    description:
      "Create a workflow that runs when a Gmail label is applied and handles the labeled inbox item.",
    promptGuidance: [
      "# Workflow Template Context",
      "",
      "The user selected the built-in workflow template: Auto-inbox label (workflow-template:auto-inbox-label).",
      "Use the workflow-setup skill to help the user create or remix a workflow for this agent.",
      "Do not execute an existing workflow. This template is only context for creating or updating a workflow.",
      "",
      "Template behavior:",
      "- Create a workflow that reacts when a named Gmail label is applied to a message.",
      "- Treat the labeled message as the inbox item to process.",
      "- Inspect the message context, decide the requested handling path, and prepare the appropriate follow-up.",
      "- Add a Gmail label-applied automation for the workflow once the user confirms the label name.",
      "",
      "Before creating anything, ask for the Gmail label name, handling rules, and final action if they are missing.",
    ].join("\n"),
  },
];

export function findWorkflowTemplateItem(
  id: string,
): WorkflowTemplateItem | undefined {
  return WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}
