import { command, computed, type Computed } from "ccstate";
import {
  connectorReconnectReasonSchema,
  type ConnectorListResponse,
  type ConnectorProvidedBinding,
  type ConnectorReconnectReason,
  type ConnectorResponse,
  type ScopeDiffResponse,
} from "@vm0/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { ConnectorSearchItem } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  connectorAuthMethodGrantMetadata,
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodRevokeMetadata,
  connectorAuthMethodRuntimeMetadata,
  connectorAuthMethodScopeDiff,
  type ConnectorOutputTarget,
} from "@vm0/connectors/connector-auth-method";
import { revokeConnectorAuthMethodAccessTokenWithMethod } from "@vm0/connectors/auth-providers";
import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorManualGrantFieldConfig,
} from "@vm0/connectors/connector-config";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import { publishConnectorChangedForUserSafely } from "../external/realtime";
import { bestEffort } from "../utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { lockConnectorState } from "./auth-state-lock.service";
import {
  userFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import {
  connectorCredentialReconnectReasonWithMethod,
  connectorCredentialStatusWithMethod,
} from "./connector-credential-status.service";
import {
  connectorCredentialSecretReadCondition,
  connectorCredentialStorageIsCompatible,
  resolveConnectorCredentialAccess,
  type ConnectorCredentialAccess,
} from "./connector-credential-access.service";
import {
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";
import { normalizeManualGrantSubmittedValuesWithMethod } from "./connector-catalog-form-fields.service";
import { searchConnectorCatalog } from "./connector-catalog-reader.service";
import {
  getConnectorRuntimeMethod,
  listConnectorRuntimeVisibleSlugs,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";

type StoredConnectorRow = {
  readonly id: string;
  readonly authMethod: ConnectorResponse["authMethod"];
  readonly externalId: string | null;
  readonly externalUsername: string | null;
  readonly externalEmail: string | null;
  readonly oauthScopes: string | null;
  readonly needsReconnect: boolean;
  readonly reconnectReason: string | null;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const oauthScopesSchema = z.array(z.string());
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 15 * 60;
type FeatureStates = ReturnType<typeof getAllFeatureStates>;

interface ExternalUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface PreparedManualGrantField {
  readonly name: string;
  readonly value: string;
}

interface ConnectorTokenOutputMetadata {
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
  readonly isRefreshable: boolean;
}

type ConnectorTokenOutputValues = Readonly<
  Record<string, string | null | undefined>
>;

interface PreparedManualGrantConnect {
  readonly secretValues: readonly PreparedManualGrantField[];
  readonly variableValues: readonly PreparedManualGrantField[];
  readonly configuredSecretNames: readonly string[];
  readonly configuredVariableNames: readonly string[];
}

type PreparedManualGrantConnectResult =
  | { readonly ok: true; readonly prepared: PreparedManualGrantConnect }
  | { readonly ok: false; readonly message: string };

type ConnectManualGrantConnectorResult =
  | { readonly status: "connected"; readonly connector: ConnectorResponse }
  | { readonly status: "invalid"; readonly message: string };

type ConnectNoAuthConnectorResult = {
  readonly status: "connected";
  readonly connector: ConnectorResponse;
};

interface EncryptedManualGrantSecret {
  readonly name: string;
  readonly encryptedValue: string;
}

interface EncryptedConnectorTokenSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

interface PreparedConnectorTokenVariable {
  readonly name: string;
  readonly value: string;
}

interface PreparedConnectorTokenState {
  readonly secrets: readonly EncryptedConnectorTokenSecret[];
  readonly variables: readonly PreparedConnectorTokenVariable[];
}

interface ConnectorTokenOutputRequirements {
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
}

interface ConnectorWithRuntimeMethod {
  readonly response: ConnectorResponse;
  readonly runtimeMethod: ConnectorRuntimeMethod;
}

type PendingConnectorTokenRevoke = {
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly encryptedInputs: Readonly<Record<string, string>>;
  readonly featureSwitchContext: FeatureSwitchContext;
};

function parseOauthScopes(value: string | null): string[] | null {
  return value ? oauthScopesSchema.parse(JSON.parse(value)) : null;
}

function parseStoredReconnectReason(
  value: string | null,
): ConnectorReconnectReason | null {
  if (value === null) {
    return null;
  }
  const parsed = connectorReconnectReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function storedConnectorRowToResponse(
  row: StoredConnectorRow,
  runtimeMethod: ConnectorRuntimeMethod,
  now: Date,
): ConnectorResponse {
  const storageCompatible = connectorCredentialStorageIsCompatible({
    runtimeMethod,
    storageVersion: row.storageVersion,
  });
  const credentialStatus = connectorCredentialStatusWithMethod({
    method: runtimeMethod.method,
    storedNeedsReconnect: row.needsReconnect,
    tokenExpiresAt: row.tokenExpiresAt,
    now,
  });
  const connectionStatus =
    !storageCompatible || credentialStatus === "reconnect-required"
      ? "reconnect-required"
      : "connected";
  return {
    id: row.id,
    slug: runtimeMethod.connectorSlug,
    authMethod: runtimeMethod.authMethodId,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: parseOauthScopes(row.oauthScopes),
    connectionStatus,
    reconnectReason: !storageCompatible
      ? null
      : connectionStatus === "reconnect-required"
        ? (parseStoredReconnectReason(row.reconnectReason) ??
          connectorCredentialReconnectReasonWithMethod({
            method: runtimeMethod.method,
            storedNeedsReconnect: row.needsReconnect,
            tokenExpiresAt: row.tokenExpiresAt,
            now,
          }))
        : null,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function manualGrantFieldsForAuthMethod(
  method: ConnectorAuthMethodRuntimeConfig,
): Record<string, ConnectorManualGrantFieldConfig> | null {
  return method?.grant.kind === "manual" ? method.grant.fields : null;
}

function sanitizeManualGrantValue(value: string): string {
  return value.replace(/\s+/gu, "");
}

/**
 * Normalize a host/domain field value to bare `host[:port]`.
 *
 * Strips the URL scheme, userinfo, path, query, fragment, and any trailing
 * slash, so a user can paste a full backend URL (e.g.
 * `https://my-project.example.app/`) into a field that is templated into a
 * firewall base URL's authority position (`https://${{ vars.X }}`), where the
 * firewall validator rejects values that introduce URL structure.
 */
function normalizeManualGrantHost(value: string): string {
  // Strip a leading scheme (e.g. "https://").
  let host = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, "");
  // Keep only the authority: drop path, query, and fragment.
  host = host.split(/[/?#]/u)[0] ?? host;
  // Drop userinfo ("user@host" -> "host").
  const atIndex = host.lastIndexOf("@");
  if (atIndex !== -1) {
    host = host.slice(atIndex + 1);
  }
  return host;
}

function formatManualGrantFieldList(names: readonly string[]): string {
  return [...names].sort().join(", ");
}

function throwCapturedAbort(error: unknown): void {
  if (error !== null) {
    throw error;
  }
}

async function finalizeConnectorStateChangeAfterCommit(args: {
  readonly userId: string;
  readonly connectorSlug: ConnectorSlug;
  readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
  readonly signal: AbortSignal;
  readonly postCommitAbort: unknown;
}): Promise<void> {
  let postCommitAbort = args.postCommitAbort;
  if (args.pendingTokenRevoke) {
    await revokePendingConnectorToken({
      pending: args.pendingTokenRevoke,
      signal: args.signal,
    });
    if (args.signal.aborted) {
      postCommitAbort ??= args.signal.reason;
    }
  }

  await publishConnectorChangedForUserSafely(args.userId, args.connectorSlug);
  if (args.signal.aborted) {
    postCommitAbort ??= args.signal.reason;
  }
  throwCapturedAbort(postCommitAbort);
}

function prepareManualGrantConnect(
  runtimeMethod: ConnectorRuntimeMethod,
  values: Readonly<Record<string, string>>,
): PreparedManualGrantConnectResult {
  const normalizedValuesResult = normalizeManualGrantSubmittedValuesWithMethod({
    connectorSlug: runtimeMethod.connectorSlug,
    authMethodId: runtimeMethod.authMethodId,
    method: runtimeMethod.method,
    values,
  });
  if (!normalizedValuesResult.ok) {
    return {
      ok: false,
      message: normalizedValuesResult.message,
    };
  }

  const fields = manualGrantFieldsForAuthMethod(runtimeMethod.method);
  if (!fields) {
    return {
      ok: false,
      message: `${runtimeMethod.connectorSlug} ${runtimeMethod.authMethodId} auth method does not use a manual grant`,
    };
  }

  const sanitizedValues = new Map<string, string>();
  for (const [name, value] of Object.entries(normalizedValuesResult.values)) {
    sanitizedValues.set(name, sanitizeManualGrantValue(value));
  }

  const secretValues: PreparedManualGrantField[] = [];
  const variableValues: PreparedManualGrantField[] = [];
  const configuredSecretNames: string[] = [];
  const configuredVariableNames: string[] = [];
  const missingRequiredNames: string[] = [];

  for (const [name, config] of Object.entries(fields)) {
    const storage = config.storage ?? "secret";
    if (storage === "variable") {
      configuredVariableNames.push(name);
    } else {
      configuredSecretNames.push(name);
    }

    const sanitized = sanitizedValues.get(name) ?? "";
    const value =
      sanitized && config.normalize === "host"
        ? normalizeManualGrantHost(sanitized)
        : sanitized;
    if (!value) {
      if (config.required) {
        missingRequiredNames.push(config.publicId);
      }
      continue;
    }

    const target = storage === "variable" ? variableValues : secretValues;
    target.push({ name, value });
  }

  if (missingRequiredNames.length > 0) {
    return {
      ok: false,
      message: `Missing required manual grant field(s): ${formatManualGrantFieldList(
        missingRequiredNames,
      )}`,
    };
  }

  return {
    ok: true,
    prepared: {
      secretValues,
      variableValues,
      configuredSecretNames,
      configuredVariableNames,
    },
  };
}

async function encryptManualGrantSecrets(args: {
  readonly secretValues: readonly PreparedManualGrantField[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedManualGrantSecret[]> {
  const encryptedSecrets: EncryptedManualGrantSecret[] = [];
  for (const field of args.secretValues) {
    encryptedSecrets.push({
      name: field.name,
      encryptedValue: await encryptStoredSecretValue(
        field.value,
        args.featureSwitchContext,
      ),
    });
    args.signal.throwIfAborted();
  }
  return encryptedSecrets;
}

export function zeroConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly featureStates?: FeatureStates;
}): Computed<Promise<ConnectorListResponse>> {
  return computed(async (get): Promise<ConnectorListResponse> => {
    const db = get(db$);
    const storedRowsPromise = db
      .select({
        id: connectors.id,
        type: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("type"),
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        needsReconnect: connectors.needsReconnect,
        reconnectReason: connectors.reconnectReason,
        storageVersion: connectors.storageVersion,
        tokenExpiresAt: connectors.tokenExpiresAt,
        createdAt: connectors.createdAt,
        updatedAt: connectors.updatedAt,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          isNotNull(connectors.connectorSlug),
        ),
      );
    const featureStatesPromise = (async () => {
      if (args.featureStates) {
        return args.featureStates;
      }
      const overrides = await get(
        userFeatureSwitchOverrides(args.orgId, args.userId),
      );
      return getAllFeatureStates({
        userId: args.userId,
        orgId: args.orgId,
        overrides,
      });
    })();
    const [storedRows, featureStates, snapshot] = await Promise.all([
      storedRowsPromise,
      featureStatesPromise,
      loadConnectorRuntimeSnapshot(db),
    ]);
    const visibleSlugs = listConnectorRuntimeVisibleSlugs({
      snapshot,
      featureStates,
    });
    // Feature switches filter visible refs for discovery only. Stored
    // connections remain manageable and executable after rollout is disabled.
    const now = nowDate();
    const connectorList: ConnectorWithRuntimeMethod[] = storedRows.map(
      (row) => {
        const runtimeMethod = getConnectorRuntimeMethod({
          snapshot,
          connectorSlug: row.type,
          authMethodId: row.authMethod,
          requireExecutable: true,
        });
        if (runtimeMethod === undefined) {
          throw new Error(
            `Stored connector ${row.type}:${row.authMethod} has no executable runtime method`,
          );
        }
        return {
          response: storedConnectorRowToResponse(row, runtimeMethod, now),
          runtimeMethod,
        };
      },
    );
    const connectorProvidedBindings =
      connectorProvidedBindingsForStoredConnectors(connectorList);

    return {
      connectors: connectorList.map((connector) => {
        return connector.response;
      }),
      configuredConnectorSlugs: [...visibleSlugs],
      connectorProvidedBindings,
    };
  });
}

function connectorProvidedBindingsForStoredConnectors(
  connectorList: readonly ConnectorWithRuntimeMethod[],
): ConnectorProvidedBinding[] {
  const provided: ConnectorProvidedBinding[] = [];
  for (const connector of connectorList) {
    if (connector.response.connectionStatus !== "connected") {
      continue;
    }
    const metadata = connectorAuthMethodRuntimeMetadata(
      connector.runtimeMethod.method,
    );
    for (const { envName, optional, source } of metadata.runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          provided.push({
            connectorSlug: connector.response.slug,
            authMethod: connector.response.authMethod,
            namespace: "secrets",
            name: envName,
            optional,
            source,
          });
          break;
        }
        case "connector-variable": {
          provided.push({
            connectorSlug: connector.response.slug,
            authMethod: connector.response.authMethod,
            namespace: "vars",
            name: envName,
            optional,
            source,
          });
          break;
        }
        case "platform-secret": {
          break;
        }
      }
    }
  }
  return provided;
}

function storedConnectorBySlug(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const db = get(db$);
    const oauthRows = await db
      .select({
        id: connectors.id,
        type: connectors.connectorSlug,
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        needsReconnect: connectors.needsReconnect,
        reconnectReason: connectors.reconnectReason,
        storageVersion: connectors.storageVersion,
        tokenExpiresAt: connectors.tokenExpiresAt,
        createdAt: connectors.createdAt,
        updatedAt: connectors.updatedAt,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, args.connectorSlug),
        ),
      )
      .limit(1);

    const oauthRow = oauthRows[0];
    if (oauthRow) {
      const runtimeMethod = getConnectorRuntimeMethod({
        snapshot: args.snapshot,
        connectorSlug: args.connectorSlug,
        authMethodId: oauthRow.authMethod,
        requireExecutable: true,
      });
      if (runtimeMethod === undefined) {
        throw new Error(
          `Stored connector ${oauthRow.type}:${oauthRow.authMethod} has no executable runtime method`,
        );
      }
      return storedConnectorRowToResponse(oauthRow, runtimeMethod, nowDate());
    }

    return null;
  });
}

export function zeroConnectorBySlug(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly snapshot?: ConnectorRuntimeSnapshot;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const snapshot =
      args.snapshot ?? (await loadConnectorRuntimeSnapshot(get(db$)));
    return await get(storedConnectorBySlug({ ...args, snapshot }));
  });
}

async function loadPendingConnectorTokenRevoke(args: {
  readonly access: ConnectorCredentialAccess;
  readonly db: Db | ReadonlyDb;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<PendingConnectorTokenRevoke | null> {
  const revokeMetadata = connectorAuthMethodRevokeMetadata(
    args.access.runtimeMethod.method,
  );
  if (revokeMetadata?.kind !== "token-revoke") {
    return null;
  }

  const inputEntries = Object.entries(revokeMetadata.inputs);
  if (inputEntries.length === 0) {
    return {
      runtimeMethod: args.access.runtimeMethod,
      encryptedInputs: {},
      featureSwitchContext: args.featureSwitchContext,
    };
  }

  const secretNames = inputEntries.map(([, input]) => {
    return input.secretName;
  });
  const secretRows = await args.db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      connectorCredentialSecretReadCondition({
        db: args.db,
        groups: [{ access: args.access, names: secretNames }],
      }),
    );
  args.signal.throwIfAborted();

  const encryptedValuesByName = new Map(
    secretRows.flatMap((row) => {
      return row.encryptedValue ? [[row.name, row.encryptedValue]] : [];
    }),
  );
  const encryptedInputs: Record<string, string> = {};
  for (const [inputName, input] of inputEntries) {
    const encryptedValue = encryptedValuesByName.get(input.secretName);
    if (!encryptedValue) {
      return null;
    }
    encryptedInputs[inputName] = encryptedValue;
  }

  return {
    runtimeMethod: args.access.runtimeMethod,
    encryptedInputs,
    featureSwitchContext: args.featureSwitchContext,
  };
}

async function decryptConnectorRevokeInputs(args: {
  readonly encryptedInputs: Readonly<Record<string, string>>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<Readonly<Record<string, string>>> {
  const inputs: Record<string, string> = {};
  for (const [name, encryptedValue] of Object.entries(args.encryptedInputs)) {
    inputs[name] = await decryptStoredSecretValue(
      encryptedValue,
      args.featureSwitchContext,
    );
  }
  return inputs;
}

async function revokePendingConnectorToken(args: {
  readonly pending: PendingConnectorTokenRevoke;
  readonly signal: AbortSignal;
}): Promise<void> {
  // Provider revocation is best-effort; local cleanup still owns visible state.
  await bestEffort(
    revokeConnectorAuthMethodAccessTokenWithMethod({
      connectorSlug: args.pending.runtimeMethod.connectorSlug,
      authMethodId: args.pending.runtimeMethod.authMethodId,
      method: args.pending.runtimeMethod.method,
      readEnv: optionalEnv,
      signal: args.signal,
      loadInputs: () => {
        return decryptConnectorRevokeInputs({
          encryptedInputs: args.pending.encryptedInputs,
          featureSwitchContext: args.pending.featureSwitchContext,
        });
      },
    }),
  );
}

export const deleteZeroConnectorLocalState$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: string;
      readonly snapshot?: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const snapshot =
      args.snapshot ?? (await loadConnectorRuntimeSnapshot(get(db$)));
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    } satisfies FeatureSwitchContext;

    let postCommitAbort: unknown = null;
    const deleteResult = await writeDb.transaction(async (tx) => {
      await lockConnectorState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.connectorSlug,
      });
      signal.throwIfAborted();

      const [existing] = await tx
        .select({
          id: connectors.id,
          authMethod: connectors.authMethod,
          storageVersion: connectors.storageVersion,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, args.connectorSlug),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      if (!existing) {
        return { deleted: false, pendingTokenRevoke: null };
      }

      const accessResult = resolveConnectorCredentialAccess({
        snapshot,
        stored: {
          authMethodId: existing.authMethod,
          connectorId: existing.id,
          connectorSlug: args.connectorSlug,
          orgId: args.orgId,
          storageVersion: existing.storageVersion,
          userId: args.userId,
        },
      });

      let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
      if (
        accessResult.kind === "ok" &&
        accessResult.access.runtimeMethod.method.revoke.kind === "token-revoke"
      ) {
        pendingTokenRevoke = await loadPendingConnectorTokenRevoke({
          access: accessResult.access,
          db: tx,
          featureSwitchContext,
          signal,
        });
      }
      signal.throwIfAborted();

      await deleteConnectorOwnedCredentialRows(tx, {
        connectorId: existing.id,
        signal,
      });
      await tx.delete(connectors).where(eq(connectors.id, existing.id));
      signal.throwIfAborted();

      return { deleted: true, pendingTokenRevoke };
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (!deleteResult.deleted) {
      throwCapturedAbort(postCommitAbort);
      return false;
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      connectorSlug: args.connectorSlug,
      pendingTokenRevoke: deleteResult.pendingTokenRevoke,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return true;
  },
);

async function upsertLocalConnectorRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly authMethod: string;
    readonly storageVersion: number;
  },
): Promise<StoredConnectorRow> {
  const [row] = await db
    .insert(connectors)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: args.connectorSlug,
      authMethod: args.authMethod,
      storageVersion: args.storageVersion,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      tokenExpiresAt: null,
      needsReconnect: false,
      reconnectReason: null,
    })
    .onConflictDoUpdate({
      target: [connectors.orgId, connectors.userId, connectors.connectorSlug],
      targetWhere: isNotNull(connectors.connectorSlug),
      set: {
        authMethod: args.authMethod,
        storageVersion: args.storageVersion,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        tokenExpiresAt: null,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({
      id: connectors.id,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      needsReconnect: connectors.needsReconnect,
      reconnectReason: connectors.reconnectReason,
      storageVersion: connectors.storageVersion,
      tokenExpiresAt: connectors.tokenExpiresAt,
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    });

  if (!row) {
    throw new Error("Failed to upsert local connector");
  }

  return row;
}

async function deleteUserSecretNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<void> {
  for (const name of args.names) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, name),
          eq(secrets.type, "user"),
        ),
      );
    args.signal.throwIfAborted();
  }
}

async function deleteVariableNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<void> {
  for (const name of args.names) {
    await db
      .delete(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          eq(variables.type, "user"),
          eq(variables.name, name),
        ),
      );
    args.signal.throwIfAborted();
  }
}

async function deleteConnectorOwnedCredentialRows(
  db: Db,
  args: {
    readonly connectorId: string;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  await db.delete(secrets).where(eq(secrets.connectorId, args.connectorId));
  args.signal.throwIfAborted();
  await db.delete(variables).where(eq(variables.connectorId, args.connectorId));
  args.signal.throwIfAborted();
}

async function cleanupExistingStoredConnectorForLocalConnect(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly signal: AbortSignal;
  },
): Promise<PendingConnectorTokenRevoke | null> {
  const [existing] = await db
    .select({
      id: connectors.id,
      authMethod: connectors.authMethod,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, args.connectorSlug),
      ),
    )
    .for("update")
    .limit(1);
  args.signal.throwIfAborted();
  if (!existing) {
    return null;
  }

  let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
  const accessResult = resolveConnectorCredentialAccess({
    snapshot: args.snapshot,
    stored: {
      authMethodId: existing.authMethod,
      connectorId: existing.id,
      connectorSlug: args.connectorSlug,
      orgId: args.orgId,
      storageVersion: existing.storageVersion,
      userId: args.userId,
    },
  });
  if (
    accessResult.kind === "ok" &&
    accessResult.access.runtimeMethod.method.revoke.kind === "token-revoke"
  ) {
    pendingTokenRevoke = await loadPendingConnectorTokenRevoke({
      access: accessResult.access,
      db,
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    });
  }

  await deleteConnectorOwnedCredentialRows(db, {
    connectorId: existing.id,
    signal: args.signal,
  });

  return pendingTokenRevoke;
}

async function writeManualGrantCredentials(
  db: Db,
  args: {
    readonly connectorId: string;
    readonly encryptedSecrets: readonly EncryptedManualGrantSecret[];
    readonly method: ConnectorRuntimeMethod["method"];
    readonly orgId: string;
    readonly signal: AbortSignal;
    readonly userId: string;
    readonly variableValues: readonly PreparedManualGrantField[];
  },
): Promise<void> {
  for (const field of args.encryptedSecrets) {
    await upsertConnectorOwnedSecret(db, {
      connectorId: args.connectorId,
      method: args.method,
      orgId: args.orgId,
      userId: args.userId,
      name: field.name,
      encryptedValue: field.encryptedValue,
      description: null,
      updatedDescription: null,
    });
    args.signal.throwIfAborted();
  }

  for (const field of args.variableValues) {
    await upsertConnectorOwnedVariable(db, {
      connectorId: args.connectorId,
      method: args.method,
      orgId: args.orgId,
      userId: args.userId,
      name: field.name,
      value: field.value,
      description: null,
      updatedDescription: null,
    });
    args.signal.throwIfAborted();
  }
}

export const connectManualGrantConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSnapshot;
      readonly values: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<ConnectManualGrantConnectorResult> => {
    const preparedResult = prepareManualGrantConnect(
      args.runtimeMethod,
      args.values,
    );
    if (!preparedResult.ok) {
      return { status: "invalid", message: preparedResult.message };
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedSecrets = await encryptManualGrantSecrets({
      secretValues: preparedResult.prepared.secretValues,
      featureSwitchContext,
      signal,
    });
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
    let connectorRow: StoredConnectorRow | null = null;
    let postCommitAbort: unknown = null;

    await writeDb.transaction(async (tx) => {
      await lockConnectorState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
      });
      signal.throwIfAborted();

      pendingTokenRevoke = await cleanupExistingStoredConnectorForLocalConnect(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: args.runtimeMethod.connectorSlug,
          snapshot: args.snapshot,
          featureSwitchContext,
          signal,
        },
      );

      connectorRow = await upsertLocalConnectorRow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        authMethod: args.runtimeMethod.authMethodId,
        storageVersion: args.runtimeMethod.method.storage.version,
      });
      signal.throwIfAborted();

      await writeManualGrantCredentials(tx, {
        connectorId: connectorRow.id,
        encryptedSecrets,
        method: args.runtimeMethod.method,
        orgId: args.orgId,
        signal,
        userId: args.userId,
        variableValues: preparedResult.prepared.variableValues,
      });

      await deleteUserSecretNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: preparedResult.prepared.configuredSecretNames,
        signal,
      });
      await deleteVariableNames(tx, {
        orgId: args.orgId,
        userId: args.userId,
        names: preparedResult.prepared.configuredVariableNames,
        signal,
      });
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (!connectorRow) {
      throw new Error("Expected manual grant connector upsert to return a row");
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      connectorSlug: args.runtimeMethod.connectorSlug,
      pendingTokenRevoke,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: storedConnectorRowToResponse(
        connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
    };
  },
);

export const connectNoAuthConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSnapshot;
    },
    signal: AbortSignal,
  ): Promise<ConnectNoAuthConnectorResult> => {
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
    let connectorRow: StoredConnectorRow | null = null;
    let postCommitAbort: unknown = null;

    await writeDb.transaction(async (tx) => {
      await lockConnectorState(tx, {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
      });
      signal.throwIfAborted();

      pendingTokenRevoke = await cleanupExistingStoredConnectorForLocalConnect(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: args.runtimeMethod.connectorSlug,
          snapshot: args.snapshot,
          featureSwitchContext,
          signal,
        },
      );

      connectorRow = await upsertLocalConnectorRow(tx, {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        authMethod: args.runtimeMethod.authMethodId,
        storageVersion: args.runtimeMethod.method.storage.version,
      });
      signal.throwIfAborted();
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (!connectorRow) {
      throw new Error("Expected no-auth connector upsert to return a row");
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      connectorSlug: args.runtimeMethod.connectorSlug,
      pendingTokenRevoke,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: storedConnectorRowToResponse(
        connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
    };
  },
);

async function encryptedConnectorTokenSecret(args: {
  readonly name: string;
  readonly value: string;
  readonly description: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<EncryptedConnectorTokenSecret> {
  return {
    name: args.name,
    encryptedValue: await encryptStoredSecretValue(
      args.value,
      args.featureSwitchContext,
    ),
    description: args.description,
  };
}

function connectorTokenExpiresAt(args: {
  readonly isRefreshable: boolean;
  readonly expiresIn: number | undefined;
}): Date | null {
  const fallbackSecs = args.isRefreshable
    ? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS
    : null;
  const expiresInSecs = args.expiresIn ?? fallbackSecs;
  return expiresInSecs === null
    ? null
    : new Date(nowDate().getTime() + expiresInSecs * 1000);
}

function connectorTokenOutputMetadataForAuthMethod(args: {
  readonly runtimeMethod: ConnectorRuntimeMethod;
}): ConnectorTokenOutputMetadata | undefined {
  const method = args.runtimeMethod.method;
  const grantMetadata = connectorAuthMethodGrantMetadata(method);

  switch (method.grant.kind) {
    case "auth-code":
    case "openid-auth":
    case "external-code":
    case "device-auth": {
      const outputTargets = Object.fromEntries(
        Object.entries(grantMetadata.outputs).map(([outputName, output]) => {
          return [outputName, output.target];
        }),
      );
      const outputRequirements = requiredConnectorTokenOutputRequirements({
        method,
        outputTargets,
      });
      return {
        outputTargets,
        requiredOutputNames: outputRequirements.requiredOutputNames,
        requiredExtraSecretNames: outputRequirements.requiredExtraSecretNames,
        isRefreshable: method.access.kind === "refresh-token",
      };
    }

    case "manual":
    case "managed":
    case "none": {
      return undefined;
    }
  }
}

function requiredConnectorTokenOutputRequirements(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
}): ConnectorTokenOutputRequirements {
  const runtimeMetadata = connectorAuthMethodRuntimeMetadata(args.method);

  const outputNameByTargetKey = new Map(
    Object.entries(args.outputTargets).map(([outputName, target]) => {
      return [connectorOutputTargetKey(target), outputName];
    }),
  );
  const requiredOutputNames = new Set<string>();
  const requiredExtraSecretNames = new Set<string>();
  for (const binding of runtimeMetadata.runtimeBindings) {
    if (binding.optional) {
      continue;
    }
    switch (binding.source.kind) {
      case "connector-secret": {
        const outputName = outputNameByTargetKey.get(
          connectorOutputTargetKey(binding.source),
        );
        if (outputName) {
          requiredOutputNames.add(outputName);
        } else {
          requiredExtraSecretNames.add(binding.source.name);
        }
        break;
      }
      case "connector-variable": {
        const outputName = outputNameByTargetKey.get(
          connectorOutputTargetKey(binding.source),
        );
        if (outputName) {
          requiredOutputNames.add(outputName);
        }
        break;
      }
      case "platform-secret": {
        break;
      }
    }
  }
  return {
    requiredOutputNames: [...requiredOutputNames],
    requiredExtraSecretNames: [...requiredExtraSecretNames],
  };
}

function connectorOutputTargetKey(target: ConnectorOutputTarget): string {
  return `${target.kind}:${target.name}`;
}

function validateConnectorTokenOutputRequirements(args: {
  readonly connectorSlug: string;
  readonly outputs: ConnectorTokenOutputValues;
  readonly requiredOutputNames: readonly string[];
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly requiredExtraSecretNames: readonly string[];
}): void {
  const missingOutputNames = args.requiredOutputNames.filter((outputName) => {
    return !args.outputs[outputName];
  });
  if (missingOutputNames.length > 0) {
    throw new Error(
      `${args.connectorSlug} connector provider did not return required token output(s): ${formatManualGrantFieldList(
        missingOutputNames,
      )}`,
    );
  }

  const extraSecretValues = new Map(args.extraSecrets);
  const missingExtraSecretNames = args.requiredExtraSecretNames.filter(
    (secretName) => {
      return !extraSecretValues.get(secretName);
    },
  );
  if (missingExtraSecretNames.length > 0) {
    throw new Error(
      `${args.connectorSlug} connector provider did not return required connector secret(s): ${formatManualGrantFieldList(
        missingExtraSecretNames,
      )}`,
    );
  }
}

function allowedConnectorTokenSecretNames(
  method: ConnectorAuthMethodRuntimeConfig,
): Set<string> {
  return new Set(connectorAuthMethodOwnedSecretNames(method));
}

function isPrimaryConnectorTokenSecret(args: {
  readonly name: string;
  readonly primaryOutputSecretNames: ReadonlySet<string>;
}): boolean {
  return args.primaryOutputSecretNames.has(args.name);
}

function validateExtraConnectorTokenSecrets(args: {
  readonly connectorSlug: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly extraConnectorSecrets: Readonly<Record<string, string>> | undefined;
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
}): readonly (readonly [string, string])[] {
  const extraSecrets = Object.entries(args.extraConnectorSecrets ?? {});
  if (extraSecrets.length === 0) {
    return [];
  }

  const allowedSecretNames = allowedConnectorTokenSecretNames(args.method);
  const primaryOutputSecretNames = connectorOutputSecretNames(
    args.outputTargets,
  );
  for (const [name] of extraSecrets) {
    if (
      isPrimaryConnectorTokenSecret({
        name,
        primaryOutputSecretNames,
      })
    ) {
      throw new Error(
        `${args.connectorSlug} connector provider returned mapped token output ${name} in extra connector secrets`,
      );
    }
    if (!allowedSecretNames.has(name)) {
      throw new Error(
        `${args.connectorSlug} connector provider returned unsupported connector secret ${name}`,
      );
    }
  }

  return extraSecrets;
}

function connectorOutputSecretNames(
  outputTargets: Readonly<Record<string, ConnectorOutputTarget>>,
): Set<string> {
  const secretNames = new Set<string>();
  for (const target of Object.values(outputTargets)) {
    if (target.kind === "connector-secret") {
      secretNames.add(target.name);
    }
  }
  return secretNames;
}

async function encryptExtraConnectorTokenSecrets(args: {
  readonly connectorSlug: string;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<readonly EncryptedConnectorTokenSecret[]> {
  const encryptedSecrets: EncryptedConnectorTokenSecret[] = [];
  for (const [name, value] of args.extraSecrets) {
    encryptedSecrets.push(
      await encryptedConnectorTokenSecret({
        name,
        value,
        description: `Connector token secret for ${args.connectorSlug}: ${name}`,
        featureSwitchContext: args.featureSwitchContext,
      }),
    );
    args.signal.throwIfAborted();
  }
  return encryptedSecrets;
}

async function prepareConnectorTokenState(args: {
  readonly connectorSlug: string;
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
  readonly outputs: ConnectorTokenOutputValues;
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly signal: AbortSignal;
}): Promise<PreparedConnectorTokenState> {
  validateConnectorTokenOutputRequirements({
    connectorSlug: args.connectorSlug,
    outputs: args.outputs,
    requiredOutputNames: args.requiredOutputNames,
    extraSecrets: args.extraSecrets,
    requiredExtraSecretNames: args.requiredExtraSecretNames,
  });

  const encryptedConnectorTokenSecrets: EncryptedConnectorTokenSecret[] = [];
  const connectorTokenVariables: PreparedConnectorTokenVariable[] = [];
  for (const [outputName, value] of Object.entries(args.outputs)) {
    if (!value) {
      continue;
    }
    const target = args.outputTargets[outputName];
    if (!target) {
      throw new Error(
        `${args.connectorSlug} connector provider returned undeclared token output ${outputName}`,
      );
    }
    if (target.kind === "connector-secret") {
      encryptedConnectorTokenSecrets.push(
        await encryptedConnectorTokenSecret({
          name: target.name,
          value,
          description: `Connector token output for ${args.connectorSlug}: ${target.name}`,
          featureSwitchContext: args.featureSwitchContext,
        }),
      );
    } else {
      connectorTokenVariables.push({ name: target.name, value });
    }
    args.signal.throwIfAborted();
  }

  encryptedConnectorTokenSecrets.push(
    ...(await encryptExtraConnectorTokenSecrets({
      connectorSlug: args.connectorSlug,
      extraSecrets: args.extraSecrets,
      featureSwitchContext: args.featureSwitchContext,
      signal: args.signal,
    })),
  );
  return {
    secrets: encryptedConnectorTokenSecrets,
    variables: connectorTokenVariables,
  };
}

async function upsertConnectorTokenSecrets(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly orgId: string;
  readonly userId: string;
  readonly secrets: readonly EncryptedConnectorTokenSecret[];
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.secrets.length === 0) {
    return;
  }

  for (const secret of args.secrets) {
    await upsertConnectorOwnedSecret(args.db, {
      connectorId: args.connectorId,
      method: args.method,
      orgId: args.orgId,
      userId: args.userId,
      name: secret.name,
      encryptedValue: secret.encryptedValue,
      description: secret.description,
      updatedDescription: secret.description,
    });
    args.signal.throwIfAborted();
  }
}

async function upsertConnectorTokenVariables(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly orgId: string;
  readonly userId: string;
  readonly variables: readonly PreparedConnectorTokenVariable[];
  readonly signal: AbortSignal;
}): Promise<void> {
  for (const variable of args.variables) {
    await upsertConnectorOwnedVariable(args.db, {
      connectorId: args.connectorId,
      method: args.method,
      orgId: args.orgId,
      userId: args.userId,
      name: variable.name,
      value: variable.value,
      description: null,
      updatedDescription: null,
    });
    args.signal.throwIfAborted();
  }
}

async function upsertPreparedConnectorTokenState(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly orgId: string;
  readonly userId: string;
  readonly state: PreparedConnectorTokenState;
  readonly signal: AbortSignal;
}): Promise<void> {
  await upsertConnectorTokenSecrets({
    db: args.db,
    connectorId: args.connectorId,
    method: args.method,
    orgId: args.orgId,
    userId: args.userId,
    secrets: args.state.secrets,
    signal: args.signal,
  });
  await upsertConnectorTokenVariables({
    db: args.db,
    connectorId: args.connectorId,
    method: args.method,
    orgId: args.orgId,
    userId: args.userId,
    variables: args.state.variables,
    signal: args.signal,
  });
}

async function loadExistingConnectorIdentity(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly signal: AbortSignal;
  },
): Promise<{
  readonly authMethod: string;
  readonly id: string;
  readonly storageVersion: number;
} | null> {
  const [existingConnector] = await db
    .select({
      authMethod: connectors.authMethod,
      id: connectors.id,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, args.connectorSlug),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return existingConnector ?? null;
}

async function upsertConnectorTokenConnectionRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly authMethod: string;
    readonly storageVersion: number;
    readonly userInfo: ExternalUserInfo;
    readonly oauthScopes: readonly string[];
    readonly tokenExpiresAt: Date | null;
    readonly signal: AbortSignal;
  },
): Promise<StoredConnectorRow> {
  const [connectorRow] = await db
    .insert(connectors)
    .values({
      userId: args.userId,
      connectorSlug: args.connectorSlug,
      authMethod: args.authMethod,
      storageVersion: args.storageVersion,
      externalId: args.userInfo.id,
      externalUsername: args.userInfo.username,
      externalEmail: args.userInfo.email,
      oauthScopes: JSON.stringify(args.oauthScopes),
      tokenExpiresAt: args.tokenExpiresAt,
      needsReconnect: false,
      reconnectReason: null,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [connectors.orgId, connectors.userId, connectors.connectorSlug],
      targetWhere: isNotNull(connectors.connectorSlug),
      set: {
        authMethod: args.authMethod,
        storageVersion: args.storageVersion,
        externalId: args.userInfo.id,
        externalUsername: args.userInfo.username,
        externalEmail: args.userInfo.email,
        oauthScopes: JSON.stringify(args.oauthScopes),
        tokenExpiresAt: args.tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({
      id: connectors.id,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      needsReconnect: connectors.needsReconnect,
      reconnectReason: connectors.reconnectReason,
      storageVersion: connectors.storageVersion,
      tokenExpiresAt: connectors.tokenExpiresAt,
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    });
  args.signal.throwIfAborted();

  if (!connectorRow) {
    throw new Error("Failed to upsert connector");
  }

  return connectorRow;
}

async function commitConnectorTokenConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorTokenState: PreparedConnectorTokenState;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly userInfo: ExternalUserInfo;
  readonly oauthScopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
  readonly signal: AbortSignal;
}): Promise<{
  readonly connectorRow: StoredConnectorRow;
  readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
}> {
  await lockConnectorState(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: args.runtimeMethod.connectorSlug,
  });
  args.signal.throwIfAborted();

  const existingConnector = await loadExistingConnectorIdentity(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: args.runtimeMethod.connectorSlug,
    signal: args.signal,
  });
  const existingAccessResult = existingConnector
    ? resolveConnectorCredentialAccess({
        snapshot: args.snapshot,
        stored: {
          authMethodId: existingConnector.authMethod,
          connectorId: existingConnector.id,
          connectorSlug: args.runtimeMethod.connectorSlug,
          orgId: args.orgId,
          storageVersion: existingConnector.storageVersion,
          userId: args.userId,
        },
      })
    : null;
  const existingAccess =
    existingAccessResult?.kind === "ok" ? existingAccessResult.access : null;
  const pendingTokenRevoke =
    existingAccess?.runtimeMethod.method.revoke.kind === "token-revoke" &&
    existingAccess.runtimeMethod.method.revoke.revokePreviousOnReplace === true
      ? await loadPendingConnectorTokenRevoke({
          access: existingAccess,
          db: args.db,
          featureSwitchContext: args.featureSwitchContext,
          signal: args.signal,
        })
      : null;

  if (existingConnector !== null) {
    await deleteConnectorOwnedCredentialRows(args.db, {
      connectorId: existingConnector.id,
      signal: args.signal,
    });
  }
  const connectorRow = await upsertConnectorTokenConnectionRow(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: args.runtimeMethod.connectorSlug,
    authMethod: args.runtimeMethod.authMethodId,
    storageVersion: args.runtimeMethod.method.storage.version,
    userInfo: args.userInfo,
    oauthScopes: args.oauthScopes,
    tokenExpiresAt: args.tokenExpiresAt,
    signal: args.signal,
  });

  await upsertPreparedConnectorTokenState({
    db: args.db,
    connectorId: connectorRow.id,
    method: args.runtimeMethod.method,
    orgId: args.orgId,
    userId: args.userId,
    state: args.connectorTokenState,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  return { connectorRow, pendingTokenRevoke };
}

export const upsertConnectorTokenConnection$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSnapshot;
      readonly outputs: ConnectorTokenOutputValues;
      readonly userInfo: ExternalUserInfo;
      readonly oauthScopes: readonly string[];
      readonly expiresIn?: number;
      readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly connector: ConnectorResponse;
    readonly created: boolean;
  }> => {
    const writeDb = set(writeDb$);
    const outputMetadata = connectorTokenOutputMetadataForAuthMethod({
      runtimeMethod: args.runtimeMethod,
    });
    if (!outputMetadata) {
      throw new Error(
        `${args.runtimeMethod.connectorSlug} connector auth method ${args.runtimeMethod.authMethodId} does not expose token outputs`,
      );
    }
    const tokenExpiresAt = connectorTokenExpiresAt({
      isRefreshable: outputMetadata.isRefreshable,
      expiresIn: args.expiresIn,
    });
    const extraSecrets = validateExtraConnectorTokenSecrets({
      connectorSlug: args.runtimeMethod.connectorSlug,
      method: args.runtimeMethod.method,
      extraConnectorSecrets: args.extraConnectorSecrets,
      outputTargets: outputMetadata.outputTargets,
    });
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const connectorTokenState = await prepareConnectorTokenState({
      connectorSlug: args.runtimeMethod.connectorSlug,
      outputTargets: outputMetadata.outputTargets,
      requiredOutputNames: outputMetadata.requiredOutputNames,
      requiredExtraSecretNames: outputMetadata.requiredExtraSecretNames,
      outputs: args.outputs,
      extraSecrets,
      featureSwitchContext,
      signal,
    });
    signal.throwIfAborted();

    let postCommitAbort: unknown = null;
    const connectionResult = await writeDb.transaction(async (tx) => {
      return await commitConnectorTokenConnection({
        db: tx,
        orgId: args.orgId,
        userId: args.userId,
        runtimeMethod: args.runtimeMethod,
        snapshot: args.snapshot,
        connectorTokenState,
        featureSwitchContext,
        userInfo: args.userInfo,
        oauthScopes: args.oauthScopes,
        tokenExpiresAt,
        signal,
      });
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    await finalizeConnectorStateChangeAfterCommit({
      userId: args.userId,
      connectorSlug: args.runtimeMethod.connectorSlug,
      pendingTokenRevoke: connectionResult.pendingTokenRevoke,
      signal,
      postCommitAbort,
    });
    signal.throwIfAborted();

    return {
      connector: storedConnectorRowToResponse(
        connectionResult.connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
      created:
        connectionResult.connectorRow.createdAt.getTime() ===
        connectionResult.connectorRow.updatedAt.getTime(),
    };
  },
);

export function zeroConnectorScopeDiff(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly snapshot?: ConnectorRuntimeSnapshot;
}): Computed<Promise<ScopeDiffResponse | null>> {
  return computed(async (get): Promise<ScopeDiffResponse | null> => {
    const snapshot =
      args.snapshot ?? (await loadConnectorRuntimeSnapshot(get(db$)));
    const connector = await get(zeroConnectorBySlug({ ...args, snapshot }));
    if (!connector) {
      return null;
    }
    const runtimeMethod = getConnectorRuntimeMethod({
      snapshot,
      connectorSlug: args.connectorSlug,
      authMethodId: connector.authMethod,
      requireExecutable: true,
    });
    return runtimeMethod === undefined
      ? null
      : connectorAuthMethodScopeDiff(
          runtimeMethod.method,
          connector.oauthScopes,
        );
  });
}

export function zeroConnectorSearch(args: {
  readonly orgId: string | undefined;
  readonly userId: string;
  readonly keyword: string | undefined;
}): Computed<Promise<ConnectorSearchItem[]>> {
  return computed(async (get) => {
    const overrides = args.orgId
      ? await get(userFeatureSwitchOverrides(args.orgId, args.userId))
      : {};
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });
    return searchConnectorCatalog({
      db: get(db$),
      keyword: args.keyword,
      featureStates,
    });
  });
}
