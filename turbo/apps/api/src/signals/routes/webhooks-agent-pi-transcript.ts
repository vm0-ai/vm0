import { command } from "ccstate";
import { webhookPiTranscriptContract } from "@vm0/api-contracts/contracts/webhooks";

import { notFound } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  PI_TRANSCRIPT_PAGE_SIZE,
  readPiTranscript,
} from "../services/pi-transcript.service";
import { chatThreadForRunFromDb } from "../services/zero-chat-thread.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const transcriptQuery$ = queryOf(webhookPiTranscriptContract.read);

const piTranscriptRead$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(transcriptQuery$);
  const auth = getSandboxAuthForRun(query.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }
  const db = get(db$);
  const thread = await chatThreadForRunFromDb(db, query.runId);
  signal.throwIfAborted();
  if (!thread) {
    return notFound("Run has no chat thread");
  }
  const transcript = await readPiTranscript(
    db,
    thread.chatThreadId,
    query.afterOrdinal,
    PI_TRANSCRIPT_PAGE_SIZE,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: transcript };
});

export const webhooksAgentPiTranscriptRoutes: readonly RouteEntry[] = [
  {
    route: webhookPiTranscriptContract.read,
    handler: piTranscriptRead$,
  },
];
