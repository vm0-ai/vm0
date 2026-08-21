import { command, computed, state } from "ccstate";
import {
  WORKFLOW_TEMPLATE_ITEMS,
  type WorkflowTemplateItem,
} from "@okouai/core/workflow-template-items";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { avatarTemplatesEnabled$ } from "../external/feature-switch.ts";
import { connectorCatalogItemBySlug } from "../external/connectors.ts";
import { slackOrgData$ } from "./zero-slack.ts";

/**
 * Entry kinds on the chat landing page. The creation kinds match the template
 * picker categories so a card can open the picker straight on its own tab;
 * `slack` is the one kind that sets something up rather than making something,
 * and it draws from the same pool so the row never grows a second line.
 */
const START_CARD_KINDS = [
  "slides",
  "website",
  "illustration",
  "video",
  "avatar",
  "workflow",
  "slack",
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
const drawnWorkflowTemplate = shuffled(WORKFLOW_TEMPLATE_ITEMS)[0];
const internalStartCardWorkflow$ = state<WorkflowTemplateItem | undefined>(
  drawnWorkflowTemplate,
);

/** The workflow template whose name and connectors the workflow card shows. */
export const startCardWorkflowTemplate$ = computed((get) => {
  return get(internalStartCardWorkflow$);
});

/** Marks shown in the workflow card's flow diagram. */
export interface StartCardConnectorIcon {
  readonly slug: ConnectorSlug;
  readonly icon: PublicConnectorCatalogIcon;
}

// The drawn template is fixed for the page load, so its lookups are built once.
// They resolve one connector each: the chat landing page must not pull the full
// connector catalog just to draw three marks.
const workflowConnectorItems$ = (drawnWorkflowTemplate?.connectorSlugs ?? [])
  .slice(0, 3)
  .map((connectorSlug) => {
    return connectorCatalogItemBySlug(connectorSlug);
  });

export const startCardWorkflowConnectorIcons$ = computed(
  async (get): Promise<readonly StartCardConnectorIcon[]> => {
    const pending = workflowConnectorItems$.map((item$) => {
      return get(item$);
    });
    const items = await Promise.all(pending);
    return items.flatMap((item) => {
      return item ? [{ slug: item.slug, icon: item.icon }] : [];
    });
  },
);

/**
 * The OAuth URL the Slack card sends the member to, or `null` when the card
 * has nothing to offer: the workspace is already connected, or this member is
 * not an admin and the app has not been installed yet.
 */
export const slackStartCardUrl$ = computed(
  async (get): Promise<string | null> => {
    const status = await get(slackOrgData$);
    if (status.isConnected) {
      return null;
    }
    return (status.isInstalled ? status.connectUrl : status.installUrl) ?? null;
  },
);

// ---------------------------------------------------------------------------
// "How it works" dialog visibility — view-local state managed in signals layer
// ---------------------------------------------------------------------------

const slackHowItWorksOpenState$ = state(false);

/** Whether the Slack explainer dialog is open. */
export const slackHowItWorksOpen$ = computed((get) => {
  return get(slackHowItWorksOpenState$);
});

/** Show or hide the Slack explainer dialog. */
export const setSlackHowItWorksOpen$ = command(({ set }, open: boolean) => {
  set(slackHowItWorksOpenState$, open);
});

/**
 * The kinds drawn for this page load.
 *
 * Async because the Slack card's eligibility comes from the integration
 * status. Resolving it before the draw is what keeps a card from being swapped
 * out from under the reader a moment after the row paints.
 */
export const startCardKinds$ = computed(
  async (get): Promise<readonly StartCardKind[]> => {
    const avatarEnabled = get(avatarTemplatesEnabled$);
    const workflowTemplate = get(startCardWorkflowTemplate$);
    const slackUrl = await get(slackStartCardUrl$);
    return get(internalStartCardOrder$)
      .filter((kind) => {
        if (kind === "avatar") {
          return avatarEnabled;
        }
        if (kind === "workflow") {
          return workflowTemplate !== undefined;
        }
        if (kind === "slack") {
          return slackUrl !== null;
        }
        return true;
      })
      .slice(0, START_CARD_COUNT);
  },
);
