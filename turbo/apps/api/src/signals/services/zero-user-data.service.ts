import { command, computed, type Computed } from "ccstate";
import type {
  ApiKeyListResponse,
  ApiKeyItem,
} from "@vm0/api-contracts/contracts/api-keys";
import type {
  SendMode,
  UpdateUserPreferencesRequest,
  UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import type {
  UpdateUserModelPreferenceRequest,
  UserModelPreferenceResponse,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import type {
  SecretListResponse,
  SecretResponse,
  SetSecretRequest,
  SecretType,
} from "@vm0/api-contracts/contracts/secrets";
import type {
  SetVariableRequest,
  VariableListResponse,
  VariableResponse,
} from "@vm0/api-contracts/contracts/variables";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, desc, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { encryptSecretValue } from "./crypto.utils";
import { isValidTimeZone } from "../utils";

const API_KEY_PREFIX_LENGTH = 12;

interface UserScopedQuery {
  readonly orgId: string;
  readonly userId: string;
}

interface SetUserSecretArgs extends UserScopedQuery {
  readonly secret: SetSecretRequest;
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

export function userModelPreference({
  orgId,
  userId,
}: UserScopedQuery): Computed<Promise<UserModelPreferenceResponse>> {
  return computed(async (get): Promise<UserModelPreferenceResponse> => {
    const db = get(db$);
    const [row] = await db
      .select({
        selectedModel: orgMembersMetadata.selectedModel,
        updatedAt: orgMembersMetadata.updatedAt,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);

    const selectedModel = isSupportedRunModel(row?.selectedModel)
      ? row.selectedModel
      : null;
    return {
      selectedModel,
      updatedAt: selectedModel ? (row?.updatedAt.toISOString() ?? null) : null,
    };
  });
}

interface UpdateUserPreferencesArgs extends UserScopedQuery {
  readonly preferences: UpdateUserPreferencesRequest;
}

type UpdateUserPreferencesResult =
  | { readonly ok: true; readonly data: UserPreferencesResponse }
  | { readonly ok: false; readonly message: string };

export const updateUserPreferences$ = command(
  async (
    { get, set },
    args: UpdateUserPreferencesArgs,
    signal: AbortSignal,
  ): Promise<UpdateUserPreferencesResult> => {
    const preferences = args.preferences;
    if (
      preferences.timezone !== undefined &&
      !isValidTimeZone(preferences.timezone)
    ) {
      return {
        ok: false,
        message: "Invalid request",
      };
    }

    const existing = await get(
      userPreferences({ orgId: args.orgId, userId: args.userId }),
    );
    signal.throwIfAborted();

    const merged: UserPreferencesResponse = {
      timezone:
        preferences.timezone !== undefined
          ? preferences.timezone
          : existing.timezone,
      pinnedAgentIds:
        preferences.pinnedAgentIds !== undefined
          ? [...preferences.pinnedAgentIds]
          : existing.pinnedAgentIds,
      sendMode:
        preferences.sendMode !== undefined
          ? preferences.sendMode
          : existing.sendMode,
      captureNetworkBodiesRemaining:
        preferences.captureNetworkBodiesRemaining !== undefined
          ? preferences.captureNetworkBodiesRemaining
          : existing.captureNetworkBodiesRemaining,
    };

    const updatedAt = nowDate();
    const writeDb = set(writeDb$);
    await writeDb
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        timezone: merged.timezone,
        pinnedAgentIds: merged.pinnedAgentIds,
        sendMode: merged.sendMode,
        captureNetworkBodiesRemaining: merged.captureNetworkBodiesRemaining,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          ...(preferences.timezone !== undefined && {
            timezone: preferences.timezone,
          }),
          ...(preferences.pinnedAgentIds !== undefined && {
            pinnedAgentIds: [...preferences.pinnedAgentIds],
          }),
          ...(preferences.sendMode !== undefined && {
            sendMode: preferences.sendMode,
          }),
          ...(preferences.captureNetworkBodiesRemaining !== undefined && {
            captureNetworkBodiesRemaining:
              preferences.captureNetworkBodiesRemaining,
          }),
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return { ok: true, data: merged };
  },
);

export const updateUserModelPreference$ = command(
  async (
    { get, set },
    args: UserScopedQuery & {
      readonly preference: UpdateUserModelPreferenceRequest;
    },
    signal: AbortSignal,
  ): Promise<UserModelPreferenceResponse> => {
    const writeDb = set(writeDb$);
    if (args.preference.selectedModel === null) {
      await writeDb
        .update(orgMembersMetadata)
        .set({ selectedModel: null, updatedAt: nowDate() })
        .where(
          and(
            eq(orgMembersMetadata.orgId, args.orgId),
            eq(orgMembersMetadata.userId, args.userId),
          ),
        );
      signal.throwIfAborted();
      return { selectedModel: null, updatedAt: null };
    }

    const updatedAt = nowDate();
    await writeDb
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        selectedModel: args.preference.selectedModel,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          selectedModel: args.preference.selectedModel,
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return get(userModelPreference({ orgId: args.orgId, userId: args.userId }));
  },
);

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

export const setUserVariable$ = command(
  async (
    { set },
    args: UserScopedQuery & { readonly variable: SetVariableRequest },
    signal: AbortSignal,
  ): Promise<VariableResponse> => {
    const updatedAt = nowDate();
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .insert(variables)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name: args.variable.name,
        value: args.variable.value,
        description: args.variable.description ?? null,
      })
      .onConflictDoUpdate({
        target: [variables.orgId, variables.userId, variables.name],
        set: {
          value: args.variable.value,
          description: args.variable.description ?? null,
          updatedAt,
        },
      })
      .returning({
        id: variables.id,
        name: variables.name,
        value: variables.value,
        description: variables.description,
        createdAt: variables.createdAt,
        updatedAt: variables.updatedAt,
      });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Expected variable upsert to return a row");
    }

    return {
      id: row.id,
      name: row.name,
      value: row.value,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },
);

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

export const setUserSecret$ = command(
  async (
    { set },
    args: SetUserSecretArgs,
    signal: AbortSignal,
  ): Promise<SecretResponse> => {
    const encryptedValue = encryptSecretValue(args.secret.value);
    const updatedAt = nowDate();
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .insert(secrets)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name: args.secret.name,
        encryptedValue,
        description: args.secret.description ?? null,
        type: "user",
      })
      .onConflictDoUpdate({
        target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
        set: {
          encryptedValue,
          description: args.secret.description ?? null,
          updatedAt,
        },
      })
      .returning({
        id: secrets.id,
        name: secrets.name,
        description: secrets.description,
        type: secrets.type,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Expected user secret upsert to return a row");
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: parseSecretType(row.type),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },
);
