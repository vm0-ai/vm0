import { cronDrainRelationshipMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { drainRelationshipSyncJobs$ } from "../services/relationship-memory-gmail.service";
import { advanceGithubMemorySourceBackfillJobs$ } from "../services/github-memory-backfill.service";
import { advanceNotionMemorySourceBackfillJobs$ } from "../services/notion-memory-backfill.service";
import { advanceGmailRelationshipBackfillJobs$ } from "../services/relationship-memory-gmail-backfill.service";
import { advanceSlackMemorySourceBackfillJobs$ } from "../services/slack-memory-backfill.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const drainRelationshipMemoryRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const backfill = await set(advanceGmailRelationshipBackfillJobs$, signal);
    signal.throwIfAborted();
    const sourceBackfill = await set(
      advanceSlackMemorySourceBackfillJobs$,
      signal,
    );
    signal.throwIfAborted();
    const githubBackfill = await set(
      advanceGithubMemorySourceBackfillJobs$,
      signal,
    );
    signal.throwIfAborted();
    const notionBackfill = await set(
      advanceNotionMemorySourceBackfillJobs$,
      signal,
    );
    signal.throwIfAborted();
    const drain = await set(drainRelationshipSyncJobs$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        ...drain,
        backfill: {
          processed:
            backfill.processed +
            sourceBackfill.processed +
            githubBackfill.processed +
            notionBackfill.processed,
          failed:
            backfill.failed +
            sourceBackfill.failed +
            githubBackfill.failed +
            notionBackfill.failed,
          scanned:
            backfill.scanned +
            sourceBackfill.scanned +
            githubBackfill.scanned +
            notionBackfill.scanned,
          enqueued:
            backfill.enqueued +
            sourceBackfill.enqueued +
            githubBackfill.enqueued +
            notionBackfill.enqueued,
        },
      },
    };
  },
);

export const cronDrainRelationshipMemoryRoutes: readonly RouteEntry[] = [
  {
    route: cronDrainRelationshipMemoryContract.drain,
    handler: drainRelationshipMemoryRoute$,
  },
];
