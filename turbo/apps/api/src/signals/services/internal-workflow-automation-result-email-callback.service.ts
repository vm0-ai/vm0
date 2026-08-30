import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { officialAutomationResultEmailClaims } from "@okouai/db/schema/official-automation-result-email-claim";
import { users } from "@okouai/db/schema/user";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  getUserEmail,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_TRUNCATION_MARKER,
  OFFICIAL_AUTOMATION_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
} from "./email-common.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { getRunOutputText } from "./run-output.service";

const log = logger("api:official-automation-result-email");
const EMPTY_RESULT_FALLBACK = "This run completed without a text result.";
const SHORT_TRUNCATION_MARKER = "…";

const callbackPayloadSchema = z
  .object({
    automationId: z.string().uuid(),
    workflowName: z.string().min(1).max(64),
    publicBrand: publicBrandSchema,
  })
  .strict();

function truncateWithMarker(
  value: string,
  maxCharacters: number,
  marker: string,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) {
    return value;
  }
  const markerCharacters = Array.from(marker);
  return [
    ...characters.slice(0, maxCharacters - markerCharacters.length),
    ...markerCharacters,
  ].join("");
}

async function userEmailIsUnsubscribed(
  db: Db,
  userId: string,
): Promise<boolean> {
  const [user] = await db
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.emailUnsubscribed ?? false;
}

function resultEmailTitle(workflowName: string): string {
  return truncateWithMarker(
    `Result from ${workflowName}`,
    OFFICIAL_AUTOMATION_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
    SHORT_TRUNCATION_MARKER,
  );
}

function resultEmailSubject(workflowName: string): string {
  return truncateWithMarker(
    `${workflowName} completed`,
    OFFICIAL_AUTOMATION_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
    SHORT_TRUNCATION_MARKER,
  );
}

function boundedResultText(output: string | undefined): string {
  const normalized = output?.trim();
  return truncateWithMarker(
    normalized || EMPTY_RESULT_FALLBACK,
    OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
    OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_TRUNCATION_MARKER,
  );
}

export async function handleWorkflowAutomationResultEmailInternalCallback(
  db: Db,
  envelope: InternalRunCallbackEnvelope,
  signal: AbortSignal = new AbortController().signal,
): Promise<InternalRunCallbackDispatchResult> {
  if (envelope.status !== "completed") {
    return { success: true, skipped: true };
  }

  const payload = callbackPayloadSchema.safeParse(envelope.payload);
  if (!payload.success) {
    return {
      success: false,
      error: "Invalid Official Automation result email callback payload",
    };
  }

  const [run] = await db
    .select({
      status: agentRuns.status,
      userId: agentRuns.userId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, envelope.runId))
    .limit(1);
  signal.throwIfAborted();
  if (run?.status !== "completed") {
    return { success: true, skipped: true };
  }

  if (await userEmailIsUnsubscribed(db, run.userId)) {
    signal.throwIfAborted();
    return { success: true, skipped: true };
  }

  const clerk = createStore().get(clerk$);
  const userEmail = await getUserEmail(db, clerk, run.userId);
  signal.throwIfAborted();
  if (!userEmail) {
    return { success: true, skipped: true };
  }

  const output = await getRunOutputText(db, envelope.runId, signal);
  const publicBrand = payload.data.publicBrand;
  const productUrl = appUrlForPublicBrand(env("APP_URL"), publicBrand);
  const manageUrl = buildUnsubscribeUrl(run.userId, publicBrand);
  const enqueued = await db.transaction(async (tx) => {
    // Linearize the final preference decision with enqueue. Both explicit
    // unsubscribe and complaint handling upsert this same row, so their write
    // locks serialize with this lock before the durable source is claimed.
    // Creating a missing row first also closes the insert-vs-insert gap for a
    // user whose preference projection has not been materialized yet.
    await tx
      .insert(users)
      .values({ id: run.userId })
      .onConflictDoNothing({ target: users.id });
    const [lockedPreference] = await tx
      .select({ emailUnsubscribed: users.emailUnsubscribed })
      .from(users)
      .where(eq(users.id, run.userId))
      .for("update")
      .limit(1);
    signal.throwIfAborted();
    if (lockedPreference?.emailUnsubscribed ?? false) {
      return false;
    }

    const [claim] = await tx
      .insert(officialAutomationResultEmailClaims)
      .values({
        runId: envelope.runId,
        workflowAutomationId: payload.data.automationId,
      })
      .onConflictDoNothing({
        target: [
          officialAutomationResultEmailClaims.runId,
          officialAutomationResultEmailClaims.workflowAutomationId,
        ],
      })
      .returning({
        emailOutboxId: officialAutomationResultEmailClaims.emailOutboxId,
      });
    signal.throwIfAborted();
    if (!claim) {
      return false;
    }

    await tx.insert(emailOutbox).values({
      id: claim.emailOutboxId,
      fromAddress: buildFromAddress(
        publicBrand === "okou" ? "okou" : "zero",
        publicBrand,
      ),
      toAddresses: userEmail,
      subject: resultEmailSubject(payload.data.workflowName),
      headers: buildUnsubscribeHeaders(
        buildOneClickUnsubscribeUrl(run.userId, publicBrand),
      ),
      publicBrand,
      template: {
        template: "official-automation-result",
        props: {
          title: resultEmailTitle(payload.data.workflowName),
          resultText: boundedResultText(output),
          runUrl: `${productUrl}/activities/${encodeURIComponent(envelope.runId)}`,
          manageUrl,
        },
      },
      sourceRunId: envelope.runId,
      sourceWorkflowAutomationId: payload.data.automationId,
      status: "pending",
      attempts: 0,
    });
    signal.throwIfAborted();
    return true;
  });
  signal.throwIfAborted();

  log.debug("Official Automation result email callback handled", {
    runId: envelope.runId,
    automationId: payload.data.automationId,
    enqueued,
  });
  return enqueued ? { success: true } : { success: true, skipped: true };
}

export const handleWorkflowAutomationResultEmailInternalCallback$ = command(
  async (
    { set },
    envelope: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleWorkflowAutomationResultEmailInternalCallback(
      set(writeDb$),
      envelope,
      signal,
    );
  },
);
