import { computed, state } from "ccstate";
import {
  WORKFLOW_TEMPLATE_ITEMS,
  type WorkflowTemplateItem,
} from "@okouai/core/workflow-template-items";
import { avatarTemplatesEnabled$ } from "../external/feature-switch.ts";

/**
 * Entry kinds on the chat landing page. The values match the template picker
 * categories so a card can open the picker straight on its own tab.
 */
const START_CARD_KINDS = [
  "slides",
  "website",
  "illustration",
  "video",
  "avatar",
  "workflow",
] as const;

export type StartCardKind = (typeof START_CARD_KINDS)[number];

/** Cards shown at once. The remaining kinds surface on the next visit. */
const START_CARD_COUNT = 3;

function shuffled<T>(items: readonly T[]): T[] {
  return items
    .map((item) => {
      return { item, order: Math.random() };
    })
    .sort((left, right) => {
      return left.order - right.order;
    })
    .map((entry) => {
      return entry.item;
    });
}

// Drawn once per page load: the row must not reshuffle while the user reads it.
const internalStartCardOrder$ = state<readonly StartCardKind[]>(
  shuffled(START_CARD_KINDS),
);
const internalStartCardWorkflow$ = state<WorkflowTemplateItem | undefined>(
  shuffled(WORKFLOW_TEMPLATE_ITEMS)[0],
);

/** The workflow template whose name and connectors the workflow card shows. */
export const startCardWorkflowTemplate$ = computed((get) => {
  return get(internalStartCardWorkflow$);
});

export const startCardKinds$ = computed((get): readonly StartCardKind[] => {
  const avatarEnabled = get(avatarTemplatesEnabled$);
  const workflowTemplate = get(startCardWorkflowTemplate$);
  return get(internalStartCardOrder$)
    .filter((kind) => {
      if (kind === "avatar") {
        return avatarEnabled;
      }
      if (kind === "workflow") {
        return workflowTemplate !== undefined;
      }
      return true;
    })
    .slice(0, START_CARD_COUNT);
});
