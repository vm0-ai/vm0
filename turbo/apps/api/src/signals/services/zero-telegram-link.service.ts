import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";

import { command, computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../external/time";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { putS3Object } from "../external/s3";
import { safeAsync } from "../utils";
import { computeContentHashFromHashes } from "./storage-content-hash.service";
import { decryptSecretValue } from "./crypto.utils";

const L = logger("api:telegram:link");
const PENDING_TELEGRAM_USER_ID = "pending";
const MAX_AUTH_AGE_SECONDS = 300;
const MAX_CONNECT_AGE_SECONDS = 600;

type TelegramUserLink = typeof telegramUserLinks.$inferSelect;
type OfficialTelegramUserLink = typeof telegramOfficialUserLinks.$inferSelect;

interface TelegramAuthData {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly photo_url?: string;
  readonly auth_date: number;
  readonly hash: string;
}

export type LinkTelegramUserResult =
  | { readonly ok: true; readonly userLink: TelegramUserLink }
  | {
      readonly ok: false;
      readonly reason: "telegram-user-linked" | "vm0-user-linked" | "conflict";
      readonly userLink?: TelegramUserLink;
    };

export type LinkOfficialTelegramUserResult =
  | { readonly ok: true; readonly userLink: OfficialTelegramUserLink }
  | {
      readonly ok: false;
      readonly reason: "telegram-user-linked" | "vm0-org-linked" | "conflict";
      readonly userLink?: OfficialTelegramUserLink;
    };

export interface TelegramInstallationForLink {
  readonly telegramBotId: string;
  readonly botUsername: string | null;
  readonly botToken: string;
  readonly orgId: string;
}

function telegramUserProfileUpdate(
  params: {
    readonly telegramUsername?: string | null;
    readonly telegramDisplayName?: string | null;
  },
  existing: {
    readonly telegramUsername: string | null;
    readonly telegramDisplayName: string | null;
  },
) {
  return {
    telegramUsername:
      params.telegramUsername === undefined
        ? existing.telegramUsername
        : normalizeTelegramUsername(params.telegramUsername),
    telegramDisplayName:
      params.telegramDisplayName === undefined
        ? existing.telegramDisplayName
        : normalizeTelegramDisplayName(params.telegramDisplayName),
    updatedAt: nowDate(),
  };
}

function normalizeTelegramUsername(
  telegramUsername: string | null | undefined,
): string | null {
  const value = telegramUsername?.trim().replace(/^@+/, "");
  return value || null;
}

function normalizeTelegramDisplayName(
  telegramDisplayName: string | null | undefined,
): string | null {
  const value = telegramDisplayName?.trim().replace(/\s+/g, " ");
  return value ? value.slice(0, 255) : null;
}

export function formatTelegramUserDisplayName(user: {
  readonly first_name?: string;
  readonly last_name?: string;
}): string | null {
  return normalizeTelegramDisplayName(
    [user.first_name, user.last_name]
      .map((part) => {
        return part?.trim();
      })
      .filter(Boolean)
      .join(" "),
  );
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyTelegramLogin(
  auth: TelegramAuthData,
  botToken: string,
): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds - auth.auth_date > MAX_AUTH_AGE_SECONDS) {
    return false;
  }

  const checkString = Object.entries(auth)
    .filter(([key]) => {
      return key !== "hash";
    })
    .filter(([, value]) => {
      return value !== undefined;
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const hmac = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return timingSafeHexEqual(hmac, auth.hash);
}

function signConnectParams(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): string {
  const normalizedTelegramUsername = normalizeTelegramUsername(
    args.telegramUsername,
  );
  const normalizedTelegramDisplayName = normalizeTelegramDisplayName(
    args.telegramDisplayName,
  );
  let data = `${args.installationId}:${args.telegramUserId}:${args.timestamp}`;
  if (normalizedTelegramUsername || normalizedTelegramDisplayName) {
    data += `:${normalizedTelegramUsername ?? ""}`;
  }
  if (normalizedTelegramDisplayName) {
    data += `:${normalizedTelegramDisplayName}`;
  }
  return createHmac("sha256", args.botToken).update(data).digest("hex");
}

export function verifyConnectSignature(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds - args.timestamp > MAX_CONNECT_AGE_SECONDS) {
    return false;
  }

  const expected = signConnectParams(args);
  return timingSafeHexEqual(expected, args.signature);
}

async function publishTelegramUserChanged(userId: string): Promise<void> {
  const publishResult = await safeAsync(() => {
    return publishUserSignal([userId], "telegram:changed");
  });
  if ("error" in publishResult) {
    L.warn("Failed to publish Telegram user change", {
      error: publishResult.error,
    });
  }
}

export function telegramInstallationForLink(args: {
  readonly botId: string;
}): Computed<Promise<TelegramInstallationForLink | null>> {
  return computed(async (get): Promise<TelegramInstallationForLink | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramBotId: telegramInstallations.telegramBotId,
        botUsername: telegramInstallations.botUsername,
        encryptedBotToken: telegramInstallations.encryptedBotToken,
        orgId: telegramInstallations.orgId,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, args.botId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      telegramBotId: row.telegramBotId,
      botUsername: row.botUsername ?? null,
      botToken: decryptSecretValue(row.encryptedBotToken),
      orgId: row.orgId,
    };
  });
}

function createEmptyTarGz(): Buffer {
  return gzipSync(Buffer.alloc(1024, 0));
}

export const ensureTelegramArtifactStorage$ = command(
  async (
    { get, set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [storage] = await writeDb
      .insert(storages)
      .values({
        name: "artifact",
        type: "artifact",
        userId: args.userId,
        s3Prefix: `${args.orgId}/artifact/artifact`,
        size: 0,
        fileCount: 0,
        orgId: args.orgId,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();

    const [currentStorage] = storage
      ? [storage]
      : await writeDb
          .select()
          .from(storages)
          .where(
            and(
              eq(storages.orgId, args.orgId),
              eq(storages.userId, args.userId),
              eq(storages.name, "artifact"),
              eq(storages.type, "artifact"),
            ),
          )
          .limit(1);
    signal.throwIfAborted();

    if (!currentStorage || currentStorage.headVersionId) {
      return;
    }

    const versionId = computeContentHashFromHashes(currentStorage.id, []);
    const s3Key = `${currentStorage.s3Prefix}/${versionId}`;
    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");

    await Promise.all([
      get(
        putS3Object(
          bucketName,
          `${s3Key}/manifest.json`,
          JSON.stringify({ files: [] }),
          "application/json",
        ),
      ),
      get(
        putS3Object(
          bucketName,
          `${s3Key}/archive.tar.gz`,
          createEmptyTarGz(),
          "application/gzip",
        ),
      ),
    ]);
    signal.throwIfAborted();

    await writeDb.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: currentStorage.id,
          s3Key,
          size: 0,
          fileCount: 0,
          message: "Initial empty artifact (auto-created)",
          createdBy: "user",
        })
        .onConflictDoNothing();

      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: 0,
          fileCount: 0,
          updatedAt: nowDate(),
        })
        .where(eq(storages.id, currentStorage.id));
    });
    signal.throwIfAborted();
  },
);

export const linkTelegramUserToVm0User$ = command(
  async (
    { set },
    params: {
      readonly installationId: string;
      readonly telegramUserId: string;
      readonly telegramUsername?: string | null;
      readonly telegramDisplayName?: string | null;
      readonly vm0UserId: string;
    },
    signal: AbortSignal,
  ): Promise<LinkTelegramUserResult> => {
    const writeDb = set(writeDb$);
    const [existingTelegramLink] = await writeDb
      .select()
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, params.installationId),
          eq(telegramUserLinks.telegramUserId, params.telegramUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingTelegramLink) {
      if (existingTelegramLink.vm0UserId !== params.vm0UserId) {
        return {
          ok: false,
          reason: "telegram-user-linked",
          userLink: existingTelegramLink,
        };
      }

      const [updated] = await writeDb
        .update(telegramUserLinks)
        .set(telegramUserProfileUpdate(params, existingTelegramLink))
        .where(eq(telegramUserLinks.id, existingTelegramLink.id))
        .returning();
      signal.throwIfAborted();

      await publishTelegramUserChanged(params.vm0UserId);
      signal.throwIfAborted();
      return { ok: true, userLink: updated ?? existingTelegramLink };
    }

    const [existingVm0Link] = await writeDb
      .select()
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, params.installationId),
          eq(telegramUserLinks.vm0UserId, params.vm0UserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingVm0Link) {
      if (existingVm0Link.telegramUserId === params.telegramUserId) {
        const [updated] = await writeDb
          .update(telegramUserLinks)
          .set(telegramUserProfileUpdate(params, existingVm0Link))
          .where(eq(telegramUserLinks.id, existingVm0Link.id))
          .returning();
        signal.throwIfAborted();

        await publishTelegramUserChanged(params.vm0UserId);
        signal.throwIfAborted();
        return { ok: true, userLink: updated ?? existingVm0Link };
      }

      if (
        existingVm0Link.telegramUserId === PENDING_TELEGRAM_USER_ID &&
        params.telegramUserId !== PENDING_TELEGRAM_USER_ID
      ) {
        const [updated] = await writeDb
          .update(telegramUserLinks)
          .set({
            telegramUserId: params.telegramUserId,
            telegramUsername: normalizeTelegramUsername(
              params.telegramUsername,
            ),
            telegramDisplayName: normalizeTelegramDisplayName(
              params.telegramDisplayName,
            ),
            updatedAt: nowDate(),
          })
          .where(eq(telegramUserLinks.id, existingVm0Link.id))
          .returning();
        signal.throwIfAborted();

        await publishTelegramUserChanged(params.vm0UserId);
        signal.throwIfAborted();
        return { ok: true, userLink: updated ?? existingVm0Link };
      }

      return {
        ok: false,
        reason: "vm0-user-linked",
        userLink: existingVm0Link,
      };
    }

    const [inserted] = await writeDb
      .insert(telegramUserLinks)
      .values({
        telegramUserId: params.telegramUserId,
        telegramUsername: normalizeTelegramUsername(params.telegramUsername),
        telegramDisplayName: normalizeTelegramDisplayName(
          params.telegramDisplayName,
        ),
        installationId: params.installationId,
        vm0UserId: params.vm0UserId,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();

    if (inserted) {
      await publishTelegramUserChanged(params.vm0UserId);
      signal.throwIfAborted();
      return { ok: true, userLink: inserted };
    }

    return { ok: false, reason: "conflict" };
  },
);

export const linkOfficialTelegramUserToVm0User$ = command(
  async (
    { set },
    params: {
      readonly telegramUserId: string;
      readonly telegramUsername?: string | null;
      readonly telegramDisplayName?: string | null;
      readonly vm0UserId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<LinkOfficialTelegramUserResult> => {
    const writeDb = set(writeDb$);
    const [existingTelegramLink] = await writeDb
      .select()
      .from(telegramOfficialUserLinks)
      .where(
        eq(telegramOfficialUserLinks.telegramUserId, params.telegramUserId),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingTelegramLink) {
      if (
        existingTelegramLink.vm0UserId !== params.vm0UserId ||
        existingTelegramLink.orgId !== params.orgId
      ) {
        return {
          ok: false,
          reason: "telegram-user-linked",
          userLink: existingTelegramLink,
        };
      }

      const [updated] = await writeDb
        .update(telegramOfficialUserLinks)
        .set({
          telegramUsername:
            params.telegramUsername === undefined
              ? existingTelegramLink.telegramUsername
              : normalizeTelegramUsername(params.telegramUsername),
          telegramDisplayName:
            params.telegramDisplayName === undefined
              ? existingTelegramLink.telegramDisplayName
              : normalizeTelegramDisplayName(params.telegramDisplayName),
          updatedAt: nowDate(),
        })
        .where(eq(telegramOfficialUserLinks.id, existingTelegramLink.id))
        .returning();
      signal.throwIfAborted();

      await publishTelegramUserChanged(params.vm0UserId);
      signal.throwIfAborted();
      return { ok: true, userLink: updated ?? existingTelegramLink };
    }

    const [existingVm0OrgLink] = await writeDb
      .select()
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.vm0UserId, params.vm0UserId),
          eq(telegramOfficialUserLinks.orgId, params.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (existingVm0OrgLink) {
      if (existingVm0OrgLink.telegramUserId === params.telegramUserId) {
        const [updated] = await writeDb
          .update(telegramOfficialUserLinks)
          .set({
            telegramUsername:
              params.telegramUsername === undefined
                ? existingVm0OrgLink.telegramUsername
                : normalizeTelegramUsername(params.telegramUsername),
            telegramDisplayName:
              params.telegramDisplayName === undefined
                ? existingVm0OrgLink.telegramDisplayName
                : normalizeTelegramDisplayName(params.telegramDisplayName),
            updatedAt: nowDate(),
          })
          .where(eq(telegramOfficialUserLinks.id, existingVm0OrgLink.id))
          .returning();
        signal.throwIfAborted();

        await publishTelegramUserChanged(params.vm0UserId);
        signal.throwIfAborted();
        return { ok: true, userLink: updated ?? existingVm0OrgLink };
      }

      return {
        ok: false,
        reason: "vm0-org-linked",
        userLink: existingVm0OrgLink,
      };
    }

    const [inserted] = await writeDb
      .insert(telegramOfficialUserLinks)
      .values({
        telegramUserId: params.telegramUserId,
        telegramUsername: normalizeTelegramUsername(params.telegramUsername),
        telegramDisplayName: normalizeTelegramDisplayName(
          params.telegramDisplayName,
        ),
        vm0UserId: params.vm0UserId,
        orgId: params.orgId,
      })
      .onConflictDoNothing()
      .returning();
    signal.throwIfAborted();

    if (inserted) {
      await publishTelegramUserChanged(params.vm0UserId);
      signal.throwIfAborted();
      return { ok: true, userLink: inserted };
    }

    return { ok: false, reason: "conflict" };
  },
);
