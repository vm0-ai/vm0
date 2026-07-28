import { createHash, randomBytes } from "node:crypto";

import type {
  StrapiIntegration,
  StrapiIntegrationSecret,
} from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import {
  strapiIntegrations,
  zeroWorkflowStrapiAutomations,
} from "@vm0/db/schema/strapi-integration";
import { and, asc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../external/time";
import type { Db, ReadonlyDb } from "../external/db";
import { safeUrlParse } from "../utils";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";

type StrapiIntegrationRow = typeof strapiIntegrations.$inferSelect;

function strapiWebhookUrl(integrationId: string): string {
  return new URL(
    `/api/zero/strapi/events/${encodeURIComponent(integrationId)}`,
    env("VM0_WEB_URL"),
  ).toString();
}

function hashStrapiIntegrationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintStrapiIntegrationToken(): string {
  return `strapi_${randomBytes(32).toString("base64url")}`;
}

function normalizeStrapiBaseUrl(value: string): string | null {
  const url = safeUrlParse(value);
  if (
    !url ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.length > 0 ? pathname : "/";
  return url.toString().replace(/\/$/, "");
}

function integrationSummary(row: StrapiIntegrationRow): StrapiIntegration {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    webhookUrl: strapiWebhookUrl(row.id),
    secretLastFour: row.secretLastFour,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listStrapiIntegrations(
  db: ReadonlyDb,
  orgId: string,
): Promise<readonly StrapiIntegration[]> {
  const rows = await db
    .select()
    .from(strapiIntegrations)
    .where(eq(strapiIntegrations.orgId, orgId))
    .orderBy(asc(strapiIntegrations.createdAt));
  return rows.map(integrationSummary);
}

type CreateStrapiIntegrationResult =
  | {
      readonly kind: "ok";
      readonly integration: StrapiIntegration & {
        readonly authorizationHeader: string;
      };
    }
  | { readonly kind: "bad_request" }
  | { readonly kind: "conflict" };

export async function createStrapiIntegration(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly baseUrl: string;
}): Promise<CreateStrapiIntegrationResult> {
  const normalizedBaseUrl = normalizeStrapiBaseUrl(args.baseUrl);
  if (!normalizedBaseUrl) {
    return { kind: "bad_request" };
  }
  const token = mintStrapiIntegrationToken();
  const currentTime = nowDate();
  const [created] = await args.db
    .insert(strapiIntegrations)
    .values({
      orgId: args.orgId,
      createdByUserId: args.userId,
      name: args.name,
      baseUrl: normalizedBaseUrl,
      normalizedBaseUrl,
      tokenHash: hashStrapiIntegrationToken(token),
      encryptedToken: await encryptPersistentSecretValue(token, {
        orgId: args.orgId,
        userId: args.userId,
      }),
      secretLastFour: token.slice(-4),
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    return { kind: "conflict" };
  }
  return {
    kind: "ok",
    integration: {
      ...integrationSummary(created),
      authorizationHeader: `Bearer ${token}`,
    },
  };
}

export async function revealStrapiIntegrationSecret(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly integrationId: string },
): Promise<StrapiIntegrationSecret | null> {
  const [row] = await db
    .select()
    .from(strapiIntegrations)
    .where(
      and(
        eq(strapiIntegrations.id, args.integrationId),
        eq(strapiIntegrations.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const token = await decryptPersistentSecretValue(row.encryptedToken, {
    orgId: row.orgId,
    userId: row.createdByUserId,
  });
  return {
    webhookUrl: strapiWebhookUrl(row.id),
    authorizationHeader: `Bearer ${token}`,
  };
}

export async function checkStrapiIntegrationTest(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly integrationId: string },
): Promise<{
  readonly received: boolean;
  readonly lastTestedAt: string | null;
} | null> {
  const [row] = await db
    .select({ lastTestedAt: strapiIntegrations.lastTestedAt })
    .from(strapiIntegrations)
    .where(
      and(
        eq(strapiIntegrations.id, args.integrationId),
        eq(strapiIntegrations.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    received: row.lastTestedAt !== null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
  };
}

type RemoveStrapiIntegrationResult = "deleted" | "not_found" | "in_use";

export async function removeStrapiIntegration(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly integrationId: string;
}): Promise<RemoveStrapiIntegrationResult> {
  const [linked] = await args.db
    .select({ automationId: zeroWorkflowStrapiAutomations.automationId })
    .from(zeroWorkflowStrapiAutomations)
    .innerJoin(
      strapiIntegrations,
      eq(strapiIntegrations.id, zeroWorkflowStrapiAutomations.integrationId),
    )
    .where(
      and(
        eq(strapiIntegrations.orgId, args.orgId),
        eq(strapiIntegrations.id, args.integrationId),
      ),
    )
    .limit(1);
  if (linked) {
    return "in_use";
  }
  const [deleted] = await args.db
    .delete(strapiIntegrations)
    .where(
      and(
        eq(strapiIntegrations.id, args.integrationId),
        eq(strapiIntegrations.orgId, args.orgId),
      ),
    )
    .returning({ id: strapiIntegrations.id });
  return deleted ? "deleted" : "not_found";
}
