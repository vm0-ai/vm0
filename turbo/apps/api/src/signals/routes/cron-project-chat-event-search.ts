import { cronProjectChatEventSearchContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { projectChatEventSearch$ } from "../services/cron-project-chat-event-search.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const projectChatEventSearchRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(projectChatEventSearch$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronProjectChatEventSearchRoutes: readonly RouteEntry[] = [
  {
    route: cronProjectChatEventSearchContract.project,
    handler: projectChatEventSearchRoute$,
  },
];
