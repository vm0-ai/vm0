import { command, createStore } from "ccstate";
import { emailOutbox } from "@vm0/db/schema/email-outbox";
import {
  morningBriefDeliveries,
  morningBriefSchedules,
} from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { nowDate } from "../external/time";
import { safeJsonParse, safeUrlParse, settle } from "../utils";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import {
  buildFromAddress,
  buildUnsubscribeHeaders,
  getUserEmail,
} from "./zero-email-common.service";
import {
  buildMorningBriefManageUrl,
  buildMorningBriefOneClickUnsubscribeUrl,
  MORNING_BRIEF_PREHEADER,
} from "./morning-brief-email-link.service";

const log = logger("api:morning-brief-email");

const MAX_OUTPUT_BYTES = 256 * 1024;

const callbackPayloadSchema = z.object({
  deliveryId: z.string(),
});

const SECTION_KEYS = [
  "schedule",
  "needs_attention",
  "github_updates",
  "email_updates",
  "suggestions",
] as const;

const morningBriefOutputSchema = z.object({
  version: z.literal(1),
  headline: z.string().max(300).optional(),
  sections: z
    .array(
      z.object({
        key: z.enum(SECTION_KEYS),
        title: z.string().min(1).max(120),
        items: z
          .array(
            z.object({
              title: z.string().min(1).max(300),
              detail: z.string().max(2000).optional(),
              url: z.string().max(2000).optional(),
            }),
          )
          .max(12),
      }),
    )
    .max(SECTION_KEYS.length),
});

type MorningBriefOutput = z.output<typeof morningBriefOutputSchema>;

function isAllowedSourceHost(hostname: string): boolean {
  return (
    hostname === "github.com" ||
    hostname === "mail.google.com" ||
    hostname === "calendar.google.com"
  );
}

/** Only https links straight into Gmail, Calendar, or GitHub survive. */
function sanitizeSourceUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const parsed = safeUrlParse(url);
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    !isAllowedSourceHost(parsed.hostname)
  ) {
    return undefined;
  }
  return url;
}

function morningBriefDateLabel(briefDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${briefDate}T00:00:00Z`));
}

function appUrl(): string {
  return env("APP_URL");
}

async function markDelivery(
  db: Db,
  deliveryId: string,
  status: "emailed" | "failed",
  error?: string,
): Promise<void> {
  await db
    .update(morningBriefDeliveries)
    .set({ status, error: error ?? null, updatedAt: nowDate() })
    .where(eq(morningBriefDeliveries.id, deliveryId));
}

type DeliveryRow = typeof morningBriefDeliveries.$inferSelect;

async function loadValidatedMorningBriefOutput(
  db: Db,
  delivery: DeliveryRow,
): Promise<MorningBriefOutput | null> {
  if (!delivery.outputKey) {
    await markDelivery(db, delivery.id, "failed", "Missing output key");
    return null;
  }
  const store = createStore();
  const downloaded = await settle(
    store.get(
      downloadS3BufferWithMaxBytes(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        delivery.outputKey,
        MAX_OUTPUT_BYTES,
      ),
    ),
  );
  if (!downloaded.ok) {
    // Missing output.json: no email and no automatic rerun.
    await markDelivery(db, delivery.id, "failed", "Missing brief output");
    return null;
  }
  const parsed = morningBriefOutputSchema.safeParse(
    safeJsonParse(downloaded.value.toString("utf8")),
  );
  if (!parsed.success) {
    // Invalid output.json: no email and no automatic rerun.
    await markDelivery(
      db,
      delivery.id,
      "failed",
      `Invalid brief output: ${parsed.error.message}`,
    );
    return null;
  }
  return parsed.data;
}

async function enqueueMorningBriefEmail(
  db: Db,
  delivery: DeliveryRow,
  output: MorningBriefOutput,
  userEmail: string,
): Promise<void> {
  const [schedule] = await db
    .select({ chatThreadId: morningBriefSchedules.chatThreadId })
    .from(morningBriefSchedules)
    .where(
      and(
        eq(morningBriefSchedules.orgId, delivery.orgId),
        eq(morningBriefSchedules.userId, delivery.userId),
      ),
    )
    .limit(1);

  const dateLabel = morningBriefDateLabel(delivery.briefDate);
  const manageUrl = buildMorningBriefManageUrl(delivery.orgId, delivery.userId);
  const continueUrl = schedule?.chatThreadId
    ? `${appUrl()}/chats/${schedule.chatThreadId}`
    : appUrl();

  await db.insert(emailOutbox).values({
    fromAddress: buildFromAddress("zero"),
    toAddresses: userEmail,
    subject: `Morning Briefing - ${dateLabel}`,
    headers: buildUnsubscribeHeaders(
      buildMorningBriefOneClickUnsubscribeUrl(delivery.orgId, delivery.userId),
    ),
    template: {
      template: "morning-brief",
      props: {
        dateLabel,
        preheader: MORNING_BRIEF_PREHEADER,
        ...(output.headline ? { headline: output.headline } : {}),
        sections: output.sections.map((section) => {
          return {
            title: section.title,
            items: section.items.map((item) => {
              const url = sanitizeSourceUrl(item.url);
              return {
                title: item.title,
                ...(item.detail ? { detail: item.detail } : {}),
                ...(url ? { url } : {}),
              };
            }),
          };
        }),
        continueUrl,
        manageUrl,
      },
    },
    status: "pending",
    attempts: 0,
  });
}

export async function handleMorningBriefEmailInternalCallback(
  db: Db,
  envelope: InternalRunCallbackEnvelope,
): Promise<InternalRunCallbackDispatchResult> {
  if (envelope.status === "progress") {
    return { success: true, skipped: true };
  }

  const payload = callbackPayloadSchema.safeParse(envelope.payload);
  if (!payload.success) {
    return { success: false, error: "Invalid morning brief callback payload" };
  }
  const deliveryId = payload.data.deliveryId;

  const [delivery] = await db
    .select()
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.id, deliveryId))
    .limit(1);
  if (!delivery) {
    return { success: false, error: "Morning brief delivery not found" };
  }
  // Idempotency guard: retried callbacks after a terminal state are no-ops.
  if (delivery.status !== "running" && delivery.status !== "collecting") {
    return { success: true, skipped: true };
  }

  if (envelope.status === "failed") {
    // Silent by design: no failure email, tomorrow's schedule tries again.
    await markDelivery(
      db,
      deliveryId,
      "failed",
      envelope.error ?? "Run failed",
    );
    return { success: true };
  }

  const output = await loadValidatedMorningBriefOutput(db, delivery);
  if (!output) {
    return { success: true };
  }

  const clerk = createStore().get(clerk$);
  const userEmail = await getUserEmail(db, clerk, delivery.userId);
  if (!userEmail) {
    await markDelivery(db, deliveryId, "failed", "No verified user email");
    return { success: true };
  }

  await enqueueMorningBriefEmail(db, delivery, output, userEmail);

  await markDelivery(db, deliveryId, "emailed");
  const successAt = nowDate();
  await db
    .update(morningBriefSchedules)
    .set({ lastSuccessAt: successAt, updatedAt: successAt })
    .where(
      and(
        eq(morningBriefSchedules.orgId, delivery.orgId),
        eq(morningBriefSchedules.userId, delivery.userId),
      ),
    );

  log.debug("morning brief email enqueued", {
    deliveryId,
    orgId: delivery.orgId,
  });
  return { success: true };
}

export const handleMorningBriefEmailInternalCallback$ = command(
  async (
    { set },
    envelope: InternalRunCallbackEnvelope,
    _signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    const db = set(writeDb$);
    return await handleMorningBriefEmailInternalCallback(db, envelope);
  },
);
