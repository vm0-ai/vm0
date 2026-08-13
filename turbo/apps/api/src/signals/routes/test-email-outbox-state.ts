import {
  testEmailOutboxStateContract,
  type TestEmailOutboxStateActionBody,
} from "@okouai/api-contracts/contracts/test-email-outbox-state";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";

import { now } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  cleanupExpiredEmailOutboxItems$,
  drainEmailOutboxItems$,
} from "../services/zero-email-common.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testEmailOutboxStateContract.action);
const drainBody$ = bodyResultOf(testEmailOutboxStateContract.drain);
const cleanupBody$ = bodyResultOf(testEmailOutboxStateContract.cleanup);

function itemStateSelection() {
  return {
    id: emailOutbox.id,
    status: emailOutbox.status,
    attempts: emailOutbox.attempts,
    resend_id: emailOutbox.resendId,
  };
}

async function applyAction(
  db: Db,
  body: TestEmailOutboxStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-item": {
      const [item] = await db
        .insert(emailOutbox)
        .values({
          fromAddress: "Zero <outbox-fixture@mail.example.com>",
          toAddresses: body.to_address,
          subject: body.subject,
          template: {
            template: "data-export-ready",
            props: {
              downloadUrl: "https://storage.example/email-outbox-fixture.zip",
              expiresAt: "January 1, 2030",
              artifactCount: 1,
            },
          },
          status: body.status,
          attempts: 0,
          createdAt: new Date(body.created_at),
        })
        .returning(itemStateSelection());
      signal.throwIfAborted();
      if (!item) {
        throw new Error("Failed to seed email outbox item");
      }
      return {
        status: 200 as const,
        body: { action: "seed-item" as const, item },
      };
    }
    case "find-item": {
      const items = await db
        .select(itemStateSelection())
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.toAddresses, body.to_address),
            eq(emailOutbox.subject, body.subject),
          ),
        )
        .orderBy(asc(emailOutbox.createdAt));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "find-item" as const, items },
      };
    }
    case "read-items": {
      const items = await db
        .select(itemStateSelection())
        .from(emailOutbox)
        .where(inArray(emailOutbox.id, body.item_ids));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "read-items" as const, items },
      };
    }
    case "delete-items": {
      const deleted = await db
        .delete(emailOutbox)
        .where(inArray(emailOutbox.id, body.item_ids))
        .returning({ id: emailOutbox.id });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "delete-items" as const, deleted: deleted.length },
      };
    }
  }
}

const mutateTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await applyAction(set(writeDb$), bodyResult.data, signal);
  },
);

const drainTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(drainBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const drained = await set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: bodyResult.data.item_ids },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { drained } };
  },
);

const cleanupTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(cleanupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const cleaned = await set(
      cleanupExpiredEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: bodyResult.data.item_ids },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { cleaned } };
  },
);

export const testEmailOutboxStateRoutes: readonly RouteEntry[] = [
  {
    route: testEmailOutboxStateContract.action,
    handler: mutateTestEmailOutboxState$,
  },
  {
    route: testEmailOutboxStateContract.drain,
    handler: drainTestEmailOutboxState$,
  },
  {
    route: testEmailOutboxStateContract.cleanup,
    handler: cleanupTestEmailOutboxState$,
  },
];
