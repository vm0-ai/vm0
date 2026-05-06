import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { command } from "ccstate";

import { generateCliToken } from "../auth/tokens";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";

const DEVICE_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BB0_DEVICE_PURPOSE = "bb0";
const DEVICE_CODE_TTL_SECONDS = 10 * 60;
const DEVICE_CODE_POLL_INTERVAL_SECONDS = 3;
const PAT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function generateDeviceCode(): string {
  let code = "";

  for (let i = 0; i < 8; i++) {
    if (i > 0 && i % 4 === 0) {
      code += "-";
    }
    code += DEVICE_CODE_CHARS[randomInt(DEVICE_CODE_CHARS.length)];
  }

  return code;
}

function generatePollToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashPollToken(pollToken: string): string {
  return createHash("sha256").update(pollToken).digest("hex");
}

async function resolveDefaultAgentId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [org] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.defaultAgentId) {
    return null;
  }

  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.id, org.defaultAgentId),
        eq(agentComposes.orgId, orgId),
      ),
    )
    .limit(1);

  return compose?.id ?? null;
}

export const createBb0DeviceCode$ = command(
  async ({ set }, bleSessionNonce: string | undefined, signal: AbortSignal) => {
    const db = set(writeDb$);
    const createdAt = nowDate();
    const expiresAt = new Date(now() + DEVICE_CODE_TTL_SECONDS * 1000);
    const code = generateDeviceCode();
    const pollToken = generatePollToken();

    await db.insert(deviceCodes).values({
      code,
      purpose: BB0_DEVICE_PURPOSE,
      status: "pending",
      bleSessionNonce,
      pollTokenHash: hashPollToken(pollToken),
      pollIntervalSeconds: DEVICE_CODE_POLL_INTERVAL_SECONDS,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    });
    signal.throwIfAborted();

    return {
      device_code: code,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
      poll_token: pollToken,
    };
  },
);

interface ConfirmBb0DeviceArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly deviceCode: string;
}

export const confirmBb0Device$ = command(
  async ({ set }, args: ConfirmBb0DeviceArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    const agentComposeId = await resolveDefaultAgentId(db, args.orgId);
    signal.throwIfAborted();

    if (!agentComposeId) {
      return { ok: false as const, reason: "missing-default-agent" as const };
    }

    const tokenId = randomUUID();
    const threadId = randomUUID();
    const createdAt = nowDate();
    const tokenExpiresAt = new Date(now() + PAT_TTL_MS);
    const token = generateCliToken(args.userId, args.orgId, tokenId);

    const result = await db.transaction(async (tx) => {
      const [approved] = await tx
        .update(deviceCodes)
        .set({
          status: "approved",
          userId: args.userId,
          orgId: args.orgId,
          cliTokenId: tokenId,
          chatThreadId: threadId,
          approvedAt: createdAt,
          updatedAt: createdAt,
        })
        .where(
          and(
            eq(deviceCodes.code, args.deviceCode),
            eq(deviceCodes.purpose, BB0_DEVICE_PURPOSE),
            eq(deviceCodes.status, "pending"),
            gt(deviceCodes.expiresAt, createdAt),
          ),
        )
        .returning({ code: deviceCodes.code });

      if (!approved) {
        return null;
      }

      await tx.insert(cliTokens).values({
        id: tokenId,
        token,
        userId: args.userId,
        name: "bb0 device",
        expiresAt: tokenExpiresAt,
        createdAt,
      });

      await tx.insert(chatThreads).values({
        id: threadId,
        userId: args.userId,
        agentComposeId,
        title: "bb0",
        createdAt,
        updatedAt: createdAt,
      });

      return {
        status: "approved" as const,
      };
    });
    signal.throwIfAborted();

    if (!result) {
      return { ok: false as const, reason: "invalid-device-code" as const };
    }

    return { ok: true as const, data: result };
  },
);

interface PollBb0DeviceArgs {
  readonly deviceCode: string;
  readonly pollToken: string;
}

export const pollBb0Device$ = command(
  async ({ set }, args: PollBb0DeviceArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    const checkedAt = nowDate();
    const pollTokenHash = hashPollToken(args.pollToken);

    const [row] = await db
      .select({
        status: deviceCodes.status,
        expiresAt: deviceCodes.expiresAt,
        pollIntervalSeconds: deviceCodes.pollIntervalSeconds,
        cliTokenId: deviceCodes.cliTokenId,
        chatThreadId: deviceCodes.chatThreadId,
        consumedAt: deviceCodes.consumedAt,
      })
      .from(deviceCodes)
      .where(
        and(
          eq(deviceCodes.code, args.deviceCode),
          eq(deviceCodes.purpose, BB0_DEVICE_PURPOSE),
          eq(deviceCodes.pollTokenHash, pollTokenHash),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!row) {
      return { status: "invalid" as const };
    }

    if (row.expiresAt.getTime() <= checkedAt.getTime()) {
      await db
        .update(deviceCodes)
        .set({ status: "expired", updatedAt: checkedAt })
        .where(
          and(
            eq(deviceCodes.code, args.deviceCode),
            eq(deviceCodes.purpose, BB0_DEVICE_PURPOSE),
          ),
        );
      signal.throwIfAborted();
      return { status: "expired" as const };
    }

    if (row.status === "pending") {
      return {
        status: "pending" as const,
        interval: row.pollIntervalSeconds ?? DEVICE_CODE_POLL_INTERVAL_SECONDS,
      };
    }

    if (
      (row.status === "approved" || row.status === "consumed") &&
      row.cliTokenId &&
      row.chatThreadId
    ) {
      const [token] = await db
        .select({ token: cliTokens.token })
        .from(cliTokens)
        .where(eq(cliTokens.id, row.cliTokenId))
        .limit(1);
      signal.throwIfAborted();

      if (!token) {
        return { status: "invalid" as const };
      }

      if (!row.consumedAt) {
        await db
          .update(deviceCodes)
          .set({
            status: "consumed",
            consumedAt: checkedAt,
            updatedAt: checkedAt,
          })
          .where(
            and(
              eq(deviceCodes.code, args.deviceCode),
              eq(deviceCodes.purpose, BB0_DEVICE_PURPOSE),
            ),
          );
        signal.throwIfAborted();
      }

      return {
        status: "approved" as const,
        api_token: token.token,
        thread_id: row.chatThreadId,
      };
    }

    if (row.status === "expired") {
      return { status: "expired" as const };
    }

    return { status: "invalid" as const };
  },
);
