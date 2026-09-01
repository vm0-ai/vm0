import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";

import { localStorageSignals } from "./external/local-storage.ts";
import { rootSignal$ } from "./root-signal.ts";
import { jsonParseOr } from "./utils.ts";

const INSTATUS_ISSUES_URL =
  "https://api.instatus.com/issues?locale=en&secretToBypassPrivacy=02c0ef5a&host=status.okou.ai";
const STATUS_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

const { get$: dismissedIssueIdsRaw$, set$: setDismissedIssueIdsRaw$ } =
  localStorageSignals("closedFrames");
const refreshVersion$ = state(0);

type InstatusIssueType = "incident" | "maintenance";

export interface InstatusIssue {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly type: InstatusIssueType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIssue(
  value: unknown,
  type: InstatusIssueType,
): InstatusIssue | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    status: value.status,
    title: value.name,
    type,
  };
}

function parseIssueList(
  value: unknown,
  type: InstatusIssueType,
): InstatusIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const issue = parseIssue(item, type);
    return issue ? [issue] : [];
  });
}

function parseIssues(value: unknown): InstatusIssue[] {
  if (!isRecord(value)) {
    return [];
  }

  return [
    ...parseIssueList(value.activeIncidents, "incident"),
    ...parseIssueList(value.activeMaintenances, "maintenance"),
  ];
}

function parseDismissedIssueIds(value: string | null): Set<string> {
  if (value === null) {
    return new Set();
  }

  const parsed = jsonParseOr<unknown>(value, []);
  return new Set(
    Array.isArray(parsed)
      ? parsed.filter((item): item is string => {
          return typeof item === "string";
        })
      : [],
  );
}

function isProductionAppHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "app.vm0.ai" || normalizedHostname === "app.okou.ai"
  );
}

const activeInstatusIssues$ = computed(
  async (get): Promise<InstatusIssue[]> => {
    get(refreshVersion$);
    if (!isProductionAppHostname(window.location.hostname)) {
      return [];
    }

    const signal = get(rootSignal$);
    const response = await fetch(INSTATUS_ISSUES_URL, { signal });
    if (!response.ok) {
      throw new Error(`Instatus issues request failed with ${response.status}`);
    }

    const result: unknown = await response.json();
    signal.throwIfAborted();
    return parseIssues(result);
  },
);

const dismissedIssueIds$ = computed((get) => {
  return parseDismissedIssueIds(get(dismissedIssueIdsRaw$));
});

export const visibleInstatusIssues$ = computed(
  async (get): Promise<InstatusIssue[]> => {
    const issues = await get(activeInstatusIssues$);
    const dismissedIssueIds = get(dismissedIssueIds$);
    return issues.filter((issue) => {
      return !dismissedIssueIds.has(issue.id);
    });
  },
);

export const dismissInstatusIssue$ = command(
  ({ get, set }, issueId: string) => {
    const nextDismissedIssueIds = new Set(get(dismissedIssueIds$));
    nextDismissedIssueIds.add(issueId);
    set(
      setDismissedIssueIdsRaw$,
      JSON.stringify(Array.from(nextDismissedIssueIds)),
    );
  },
);

export const pollInstatusIssues$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    if (!isProductionAppHostname(window.location.hostname)) {
      return;
    }

    while (!signal.aborted) {
      await delay(STATUS_REFRESH_INTERVAL_MS, { signal });
      set(refreshVersion$, (version) => {
        return version + 1;
      });
    }
  },
);
