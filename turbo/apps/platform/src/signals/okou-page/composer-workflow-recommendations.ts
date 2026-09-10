import { command, computed, state, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { WorkflowTemplateItem } from "@okouai/core/workflow-template-items";

export const WORKFLOW_RECOMMENDATIONS = [
  {
    id: "morning",
    group: "daily",
    templateId: "workflow-template:morning-brief",
    connectors: ["gmail", "google-calendar", "slack"],
  },
  {
    id: "meetings",
    group: "daily",
    templateId: "workflow-template:research-calendar-meetings",
    connectors: ["google-calendar"],
  },
  {
    id: "inbox",
    group: "daily",
    templateId: "workflow-template:sort-gmail-draft-replies",
    connectors: ["gmail"],
  },
  {
    id: "weekly",
    group: "daily",
    templateId: "workflow-template:personal-weekly-digest",
    connectors: ["slack"],
  },
  {
    id: "recap",
    group: "operations",
    templateId: "workflow-template:meeting-recaps-slack",
    connectors: ["fireflies"],
  },
  {
    id: "invoices",
    group: "operations",
    templateId: "workflow-template:file-gmail-invoices-drive",
    connectors: ["gmail", "google-drive"],
  },
  {
    id: "competitors",
    group: "business",
    templateId: "workflow-template:competitive-intel-monitor",
    connectors: ["firecrawl", "notion"],
  },
  {
    id: "metrics",
    group: "business",
    templateId: "workflow-template:post-daily-metrics-slack",
    connectors: ["plausible", "slack"],
  },
  { id: "reply", group: "daily", templateId: null, connectors: ["gmail"] },
] as const satisfies readonly {
  readonly id: string;
  readonly group: string;
  readonly templateId: WorkflowTemplateItem["id"] | null;
  readonly connectors: readonly ConnectorSlug[];
}[];

export type WorkflowRecommendation = (typeof WORKFLOW_RECOMMENDATIONS)[number];
export type WorkflowRecommendationId = WorkflowRecommendation["id"];
export type WorkflowRecommendationCategory =
  | "all"
  | WorkflowRecommendation["group"];

export function createWorkflowRecommendationSignals(
  visible$: Computed<boolean>,
) {
  const internalView$ = state<"catalog" | WorkflowRecommendationId | null>(
    null,
  );
  const internalCategory$ = state<WorkflowRecommendationCategory>("all");
  const internalContext$ = state("");
  const internalFocusAfterClose$ = state(false);
  const view$ = computed((get) => {
    return get(visible$) ? get(internalView$) : null;
  });
  const category$ = computed((get) => {
    return get(internalCategory$);
  });
  const context$ = computed((get) => {
    return get(internalContext$);
  });
  const open$ = command(
    ({ get, set }, view: "catalog" | WorkflowRecommendationId) => {
      if (!get(visible$)) {
        return;
      }
      set(internalView$, view);
      set(internalContext$, "");
    },
  );
  const close$ = command(({ set }) => {
    set(internalView$, null);
    set(internalContext$, "");
  });
  const closeForUse$ = command(({ set }) => {
    set(internalFocusAfterClose$, true);
    set(close$);
  });
  const completeClose$ = command(({ get, set }) => {
    const shouldFocus = get(internalFocusAfterClose$);
    set(internalFocusAfterClose$, false);
    return shouldFocus;
  });
  const setCategory$ = command(
    ({ set }, category: WorkflowRecommendationCategory) => {
      set(internalCategory$, category);
    },
  );
  const setContext$ = command(({ set }, value: string) => {
    set(internalContext$, value);
  });
  return {
    view$,
    category$,
    context$,
    open$,
    close$,
    closeForUse$,
    completeClose$,
    setCategory$,
    setContext$,
  };
}
