import {
  testMailDraftStateContract,
  type TestMailDraftStateActionBody,
} from "@vm0/api-contracts/contracts/test-mail-draft-state";
import type { ZeroMailLegacyDraft } from "@vm0/api-contracts/contracts/zero-mail";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { mailDrafts } from "@vm0/db/schema/mail-draft";
import { command, computed } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

// Production deliberately has no endpoint that reveals whether inaccessible
// email content still exists. Keep this test-only read surface narrow so the
// lifecycle test can detect orphaned mail_drafts rows after thread deletion.
const getMailDraftState$ = computed(async (get) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const { mailDraftId } = get(pathParamsOf(testMailDraftStateContract.get));
  const [draft] = await get(db$)
    .select({ id: mailDrafts.id })
    .from(mailDrafts)
    .where(eq(mailDrafts.id, mailDraftId))
    .limit(1);

  return { status: 200 as const, body: { exists: Boolean(draft) } };
});

const actionBody$ = bodyResultOf(testMailDraftStateContract.action);

type MailDraftStateAction<
  TAction extends TestMailDraftStateActionBody["action"],
> = Extract<TestMailDraftStateActionBody, { action: TAction }>;

async function createPreviousVersionDraft(
  db: Db,
  body: MailDraftStateAction<"create-previous-version-draft">,
  signal: AbortSignal,
) {
  const timestamp = "2026-07-18T00:00:00.000Z";
  const draft: ZeroMailLegacyDraft = {
    version: 1,
    provider: "gmail",
    from: "previous-writer@example.com",
    to: ["recipient@example.com"],
    subject: "Previous-version draft",
    body: "Created by the previous API write shape",
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await db.transaction(async (tx) => {
    await tx.insert(chatMessages).values({
      chatThreadId: body.threadId,
      role: "assistant",
      content: null,
      mailDraftId: body.mailDraftId,
    });
    await tx.execute(sql`
      INSERT INTO ${mailDrafts} (${sql.identifier("id")}, ${sql.identifier("draft")})
      VALUES (${body.mailDraftId}, ${JSON.stringify(draft)}::jsonb)
    `);
  });
  signal.throwIfAborted();

  return { status: 200 as const, body: { ok: true as const } };
}

const mutateMailDraftState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    switch (bodyResult.data.action) {
      case "create-previous-version-draft": {
        return await createPreviousVersionDraft(
          set(writeDb$),
          bodyResult.data,
          signal,
        );
      }
    }
  },
);

export const testMailDraftStateRoutes: readonly RouteEntry[] = [
  {
    route: testMailDraftStateContract.action,
    handler: mutateMailDraftState$,
  },
  {
    route: testMailDraftStateContract.get,
    handler: getMailDraftState$,
  },
];
