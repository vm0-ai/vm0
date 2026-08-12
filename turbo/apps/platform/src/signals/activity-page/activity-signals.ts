import { computed } from "ccstate";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { pathParams$ } from "../route.ts";
import {
  formatActivityClockTime,
  formatActivityDurationMs,
} from "./activity-time.ts";

export const currentRunId$ = computed((get) => {
  const params = get(pathParams$);
  if (params && typeof params === "object" && "activityRunId" in params) {
    return String(params.activityRunId);
  }
  return null;
});

export const zeroActivityDetail$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const result = await accept(
    get(zeroClient$)(logsByIdContract).getById({
      params: { id: runId },
    }),
    [200],
  );
  return result.body;
});

export function formatLogTime(createdAt: string): string {
  return formatActivityClockTime(createdAt);
}

export function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
): string | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  return formatActivityDurationMs(ms);
}
