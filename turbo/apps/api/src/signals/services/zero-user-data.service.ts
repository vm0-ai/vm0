import { command, computed, type Computed } from "ccstate";
import {
  SUPPORTED_USER_LOCALES,
  type SendMode,
  type UserLocale,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import type {
  UpdateUserModelPreferenceRequest,
  UserModelPreferenceResponse,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import {
  isCodexFastModeModel,
  isSupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import type {
  SecretResponse,
  SecretType,
} from "@vm0/api-contracts/contracts/secrets";
import type { VariableListResponse } from "@vm0/api-contracts/contracts/variables";
import { morningBriefSchedules } from "@vm0/db/schema/morning-brief";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { syncMorningBriefSchedule } from "./morning-brief-schedule.service";
import { isValidTimeZone } from "../utils";

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
    value === "ja-JP" ||
    value === "ko-KR" ||
    value === "id-ID" ||
    value === "de-DE" ||
    value === "es-ES" ||
    value === "it-IT" ||
    value === "fr-FR" ||
    value === "hi-IN"
  ) {
    return value;
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
        supportedLocales: [...SUPPORTED_USER_LOCALES],
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
      supportedLocales: [...SUPPORTED_USER_LOCALES],
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
        codexServiceTier: orgMembersMetadata.codexServiceTier,
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
    const codexServiceTier =
      selectedModel &&
      isCodexFastModeModel(selectedModel) &&
      row?.codexServiceTier === "fast"
        ? "fast"
        : null;
    return {
      selectedModel,
      codexServiceTier,
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
      supportedLocales: [...SUPPORTED_USER_LOCALES],
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
        .set({
          selectedModel: null,
          codexServiceTier: null,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(orgMembersMetadata.orgId, args.orgId),
            eq(orgMembersMetadata.userId, args.userId),
          ),
        );
      signal.throwIfAborted();
      return {
        selectedModel: null,
        codexServiceTier: null,
        updatedAt: null,
      };
    }

    const codexServiceTier =
      args.preference.codexServiceTier === "fast" &&
      isCodexFastModeModel(args.preference.selectedModel)
        ? "fast"
        : null;
    const updatedAt = nowDate();
    await writeDb
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        selectedModel: args.preference.selectedModel,
        codexServiceTier,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          selectedModel: args.preference.selectedModel,
          codexServiceTier,
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
