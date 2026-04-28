import { randomInt, randomUUID } from "node:crypto";

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
const DEVICE_CODE_TTL_SECONDS = 5 * 60;
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
  async ({ set }, bleSessionNonce: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const createdAt = nowDate();
    const expiresAt = new Date(now() + DEVICE_CODE_TTL_SECONDS * 1000);
    const code = generateDeviceCode();

    await db.insert(deviceCodes).values({
      code,
      purpose: BB0_DEVICE_PURPOSE,
      status: "pending",
      bleSessionNonce,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    });
    signal.throwIfAborted();

    return {
      device_code: code,
      expires_in: DEVICE_CODE_TTL_SECONDS,
    };
  },
);

interface BindBb0DeviceArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly deviceCode: string;
  readonly bleSessionNonce: string;
}

export const bindBb0Device$ = command(
  async ({ set }, args: BindBb0DeviceArgs, signal: AbortSignal) => {
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
      const [consumed] = await tx
        .delete(deviceCodes)
        .where(
          and(
            eq(deviceCodes.code, args.deviceCode),
            eq(deviceCodes.purpose, BB0_DEVICE_PURPOSE),
            eq(deviceCodes.status, "pending"),
            eq(deviceCodes.bleSessionNonce, args.bleSessionNonce),
            gt(deviceCodes.expiresAt, createdAt),
          ),
        )
        .returning({ code: deviceCodes.code });

      if (!consumed) {
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
        api_token: token,
        thread_id: threadId,
      };
    });
    signal.throwIfAborted();

    if (!result) {
      return { ok: false as const, reason: "invalid-device-code" as const };
    }

    return { ok: true as const, data: result };
  },
);
