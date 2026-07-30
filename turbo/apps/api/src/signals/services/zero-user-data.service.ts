import { command, computed, type Computed } from "ccstate";
import type {
  SendMode,
  UserLocale,
  UpdateUserPreferencesRequest,
  UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import type {
  UpdateUserModelPreferenceRequest,
  UserModelPreferenceResponse,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import type {
  SecretResponse,
  SetSecretRequest,
  SecretType,
} from "@vm0/api-contracts/contracts/secrets";
import type {
  SetVariableRequest,
  VariableListResponse,
  VariableResponse,
} from "@vm0/api-contracts/contracts/variables";
import { morningBriefSchedules } from "@vm0/db/schema/morning-brief";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, isNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { encryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { syncMorningBriefSchedule } from "./morning-brief-schedule.service";
import { isValidTimeZone } from "../utils";

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

function normalizePinnedAgentIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function parseSendMode(value: unknown): SendMode {
  return value === "cmd-enter" ? "cmd-enter" : "enter";
}

function parseUserLocale(value: unknown): UserLocale | null {
  if (
    value === null ||
    value === "en-US" ||
    value === "pt-BR" ||
    value === "ja-JP"
  ) {
    return value;
  }
  // TODO(#23508): remove after persisted legacy values are migrated.
  if (value === "zh-CN") {
    return "en-US";
  }
  throw new Error(`Unexpected user locale: ${String(value)}`);
}

function parseSecretType(value: string): SecretType {
  if (value === "user" || value === "model-provider" || value === "connector") {
    return value;
  }
  throw new Error(`Unexpected secret type: ${value}`);
}

async function loadMorningBriefNextRunAt(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ nextRunAt: morningBriefSchedules.nextRunAt })
    .from(morningBriefSchedules)
    .where(
      and(
        eq(morningBriefSchedules.orgId, orgId),
        eq(morningBriefSchedules.userId, userId),
      ),
    )
    .limit(1);
  return row?.nextRunAt?.toISOString() ?? null;
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
        locale: orgMembersMetadata.locale,
        pinnedAgentIds: orgMembersMetadata.pinnedAgentIds,
        sendMode: orgMembersMetadata.sendMode,
        morningBriefEnabled: orgMembersMetadata.morningBriefEnabled,
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
        locale: null,
        pinnedAgentIds: [],
        sendMode: "enter",
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      };
    }

    return {
      timezone: row.timezone,
      locale: parseUserLocale(row.locale),
      pinnedAgentIds: normalizePinnedAgentIds(
        toStringArray(row.pinnedAgentIds),
      ),
      sendMode: parseSendMode(row.sendMode),
      morningBriefEnabled: row.morningBriefEnabled,
      morningBriefNextRunAt: await loadMorningBriefNextRunAt(db, orgId, userId),
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
  readonly allowBrazilianPortuguese?: boolean;
  readonly allowJapanese?: boolean;
}

type UpdateUserPreferencesResult =
  | { readonly ok: true; readonly data: UserPreferencesResponse }
  | { readonly ok: false; readonly message: string };

function isUserPreferencesUpdateAllowed(
  args: UpdateUserPreferencesArgs,
): boolean {
  const { locale, timezone } = args.preferences;
  return (
    (locale !== "pt-BR" || args.allowBrazilianPortuguese === true) &&
    (locale !== "ja-JP" || args.allowJapanese === true) &&
    (timezone === undefined || isValidTimeZone(timezone))
  );
}

export const updateUserPreferences$ = command(
  async (
    { get, set },
    args: UpdateUserPreferencesArgs,
    signal: AbortSignal,
  ): Promise<UpdateUserPreferencesResult> => {
    const preferences = args.preferences;
    if (!isUserPreferencesUpdateAllowed(args)) {
      return {
        ok: false,
        message: "Invalid request",
      };
    }

    const existing = await get(
      userPreferences({ orgId: args.orgId, userId: args.userId }),
    );
    signal.throwIfAborted();

    const merged: Omit<UserPreferencesResponse, "morningBriefNextRunAt"> & {
      readonly locale: UserLocale | null;
    } = {
      timezone:
        preferences.timezone !== undefined
          ? preferences.timezone
          : existing.timezone,
      locale:
        preferences.locale !== undefined
          ? preferences.locale
          : (existing.locale ?? null),
      pinnedAgentIds:
        preferences.pinnedAgentIds !== undefined
          ? normalizePinnedAgentIds(preferences.pinnedAgentIds)
          : existing.pinnedAgentIds,
      sendMode:
        preferences.sendMode !== undefined
          ? preferences.sendMode
          : existing.sendMode,
      morningBriefEnabled:
        preferences.morningBriefEnabled !== undefined
          ? preferences.morningBriefEnabled
          : existing.morningBriefEnabled,
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
        locale: merged.locale,
        pinnedAgentIds: merged.pinnedAgentIds,
        sendMode: merged.sendMode,
        morningBriefEnabled: merged.morningBriefEnabled,
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
          ...(preferences.locale !== undefined && {
            locale: preferences.locale,
          }),
          ...(preferences.pinnedAgentIds !== undefined && {
            pinnedAgentIds: normalizePinnedAgentIds(preferences.pinnedAgentIds),
          }),
          ...(preferences.sendMode !== undefined && {
            sendMode: preferences.sendMode,
          }),
          ...(preferences.morningBriefEnabled !== undefined && {
            morningBriefEnabled: preferences.morningBriefEnabled,
          }),
          ...(preferences.captureNetworkBodiesRemaining !== undefined && {
            captureNetworkBodiesRemaining:
              preferences.captureNetworkBodiesRemaining,
          }),
          updatedAt,
        },
      });
    signal.throwIfAborted();

    if (
      preferences.timezone !== undefined ||
      preferences.morningBriefEnabled !== undefined
    ) {
      await syncMorningBriefSchedule(writeDb, {
        orgId: args.orgId,
        userId: args.userId,
        timezone: merged.timezone,
        enabled: merged.morningBriefEnabled,
        currentTime: updatedAt,
      });
      signal.throwIfAborted();
    }

    return {
      ok: true,
      data: {
        ...merged,
        morningBriefNextRunAt: await loadMorningBriefNextRunAt(
          writeDb,
          args.orgId,
          args.userId,
        ),
      },
    };
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
      .where(
        and(
          eq(variables.orgId, orgId),
          eq(variables.userId, userId),
          eq(variables.type, "user"),
        ),
      )
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
        type: "user",
      })
      .onConflictDoUpdate({
        target: [
          variables.orgId,
          variables.userId,
          variables.type,
          variables.name,
        ],
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

export function userSecrets({ orgId, userId }: UserScopedQuery): Computed<
  Promise<{
    readonly secrets: SecretResponse[];
    readonly connectorOwnerBySecretId: ReadonlyMap<string, string | null>;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const rows = await db
      .select({
        id: secrets.id,
        name: secrets.name,
        description: secrets.description,
        connectorId: secrets.connectorId,
        type: secrets.type,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      })
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.userId, userId)))
      .orderBy(secrets.name);

    return {
      connectorOwnerBySecretId: new Map(
        rows.map((row) => {
          return [row.id, row.connectorId] as const;
        }),
      ),
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
    { get, set },
    args: SetUserSecretArgs,
    signal: AbortSignal,
  ): Promise<SecretResponse> => {
    const writeDb = set(writeDb$);
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedValue = await encryptStoredSecretValue(
      args.secret.value,
      featureSwitchContext,
    );
    signal.throwIfAborted();
    const updatedAt = nowDate();
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
        targetWhere: isNull(secrets.connectorId),
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
