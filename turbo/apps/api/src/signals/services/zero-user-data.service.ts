import { computed, type Computed } from "ccstate";
import type {
  ApiKeyListResponse,
  ApiKeyItem,
} from "@vm0/api-contracts/contracts/api-keys";
import type {
  SendMode,
  UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import type {
  SecretListResponse,
  SecretType,
} from "@vm0/api-contracts/contracts/secrets";
import type { VariableListResponse } from "@vm0/api-contracts/contracts/variables";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, desc, eq } from "drizzle-orm";

import { db$ } from "../external/db";

const API_KEY_PREFIX_LENGTH = 12;

interface UserScopedQuery {
  readonly orgId: string;
  readonly userId: string;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

function parseSendMode(value: unknown): SendMode {
  return value === "cmd-enter" ? "cmd-enter" : "enter";
}

function parseSecretType(value: string): SecretType {
  if (value === "user" || value === "model-provider" || value === "connector") {
    return value;
  }
  throw new Error(`Unexpected secret type: ${value}`);
}

function apiKeyItem(row: {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
}): ApiKeyItem {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: `${row.token.slice(0, API_KEY_PREFIX_LENGTH)}\u2026`,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

export function userApiKeys(
  userId: string,
): Computed<Promise<ApiKeyListResponse>> {
  return computed(async (get): Promise<ApiKeyListResponse> => {
    const db = get(db$);
    const rows = await db
      .select({
        id: cliTokens.id,
        name: cliTokens.name,
        token: cliTokens.token,
        createdAt: cliTokens.createdAt,
        expiresAt: cliTokens.expiresAt,
        lastUsedAt: cliTokens.lastUsedAt,
      })
      .from(cliTokens)
      .where(eq(cliTokens.userId, userId))
      .orderBy(desc(cliTokens.createdAt));

    return { apiKeys: rows.map(apiKeyItem) };
  });
}

export function userPreferences({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<UserPreferencesResponse>> {
  return computed(async (get): Promise<UserPreferencesResponse> => {
    const db = get(db$);
    const [row] = await db
      .select({
        timezone: orgMembersMetadata.timezone,
        pinnedAgentIds: orgMembersMetadata.pinnedAgentIds,
        sendMode: orgMembersMetadata.sendMode,
        captureNetworkBodiesRemaining:
          orgMembersMetadata.captureNetworkBodiesRemaining,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        timezone: null,
        pinnedAgentIds: [],
        sendMode: "enter",
        captureNetworkBodiesRemaining: 0,
      };
    }

    return {
      timezone: row.timezone,
      pinnedAgentIds: toStringArray(row.pinnedAgentIds),
      sendMode: parseSendMode(row.sendMode),
      captureNetworkBodiesRemaining: row.captureNetworkBodiesRemaining ?? 0,
    };
  });
}

export function userVariables({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<VariableListResponse>> {
  return computed(async (get): Promise<VariableListResponse> => {
    const db = get(db$);
    const rows = await db
      .select({
        id: variables.id,
        name: variables.name,
        value: variables.value,
        description: variables.description,
        createdAt: variables.createdAt,
        updatedAt: variables.updatedAt,
      })
      .from(variables)
      .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId)))
      .orderBy(variables.name);

    return {
      variables: rows.map((row) => {
        return {
          id: row.id,
          name: row.name,
          value: row.value,
          description: row.description,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });
}

export function userSecrets({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<SecretListResponse>> {
  return computed(async (get): Promise<SecretListResponse> => {
    const db = get(db$);
    const rows = await db
      .select({
        id: secrets.id,
        name: secrets.name,
        description: secrets.description,
        type: secrets.type,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      })
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.userId, userId)))
      .orderBy(secrets.name);

    return {
      secrets: rows.map((row) => {
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          type: parseSecretType(row.type),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });
}
