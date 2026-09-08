import {
  getFrameworkForType,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { secrets } from "@okouai/db/schema/secret";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { lockModelProviderState } from "./auth-state-lock.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { extractCodexAccountEmailFromIdToken } from "./codex-auth-json-parser";

const MAX_PERSONAL_PROVIDER_ACCOUNTS = 10;
const CODEX_TYPE = "codex-oauth-token";
const CLAUDE_CODE_TYPE = "claude-code-oauth-token";
const CODEX_ACCOUNT_ID_SECRET = "CHATGPT_ACCOUNT_ID";
const CODEX_ID_TOKEN_SECRET = "CHATGPT_ID_TOKEN";

export type PersonalSubscriptionProviderType =
  | typeof CODEX_TYPE
  | typeof CLAUDE_CODE_TYPE;

export function isPersonalSubscriptionProviderType(
  type: string,
): type is PersonalSubscriptionProviderType {
  return type === CODEX_TYPE || type === CLAUDE_CODE_TYPE;
}

interface PersonalProviderAccountMetadata {
  readonly externalAccountId?: string | null;
  readonly accountEmail?: string | null;
  readonly tokenExpiresAt?: Date | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
}

export type PersonalProviderAccountMutation =
  | { readonly kind: "add" }
  | { readonly kind: "replace-active" }
  | { readonly kind: "reconnect"; readonly accountId: string };

interface EncryptedAccountSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

type AccountRow = typeof modelProviderAccounts.$inferSelect;
type ProviderRow = typeof modelProviders.$inferSelect;
export type PersonalProviderAccountErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>;

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizedEmail(value: string | null | undefined): string | null {
  return normalizedText(value)?.toLowerCase() ?? null;
}

function accountResponse(args: {
  readonly account: AccountRow;
  readonly provider: ProviderRow;
}): ModelProviderResponse {
  const { account, provider } = args;
  const type = account.type as PersonalSubscriptionProviderType;
  const authMethod = account.authMethod;
  return {
    id: account.id,
    modelProviderId: provider.id,
    isActive: account.isActive,
    type,
    framework: getFrameworkForType(type),
    secretName: getSecretNameForType(type) ?? null,
    authMethod,
    secretNames: authMethod
      ? (getSecretNamesForAuthMethod(type, authMethod) ?? null)
      : null,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    accountEmail: account.accountEmail,
    workspaceName: account.workspaceName,
    planType: account.planType,
    subscriptionResetPeriod: account.subscriptionResetPeriod,
    subscriptionNextResetAt:
      account.subscriptionNextResetAt?.toISOString() ?? null,
    needsReconnect: account.needsReconnect,
    lastRefreshErrorCode: account.lastRefreshErrorCode,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

async function encryptAccountSecrets(
  type: PersonalSubscriptionProviderType,
  values: Readonly<Record<string, string>>,
  featureSwitchContext: FeatureSwitchContext,
  signal: AbortSignal,
): Promise<readonly EncryptedAccountSecret[]> {
  const encrypted: EncryptedAccountSecret[] = [];
  for (const [name, value] of Object.entries(values)) {
    encrypted.push({
      name,
      encryptedValue: await encryptStoredSecretValue(
        value,
        featureSwitchContext,
      ),
      description: `Personal ${type} account secret: ${name}`,
    });
    signal.throwIfAborted();
  }
  return encrypted;
}

async function legacySecretRows(
  db: Db,
  provider: ProviderRow,
): Promise<readonly EncryptedAccountSecret[]> {
  if (provider.secretId) {
    const rows = await db
      .select({
        name: secrets.name,
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(eq(secrets.id, provider.secretId));
    return rows.map((row) => {
      return {
        name: row.name,
        encryptedValue: row.encryptedValue,
        description:
          row.description ?? `Personal ${provider.type} account secret`,
      };
    });
  }

  if (
    !provider.authMethod ||
    !isPersonalSubscriptionProviderType(provider.type)
  ) {
    return [];
  }
  const names = getSecretNamesForAuthMethod(provider.type, provider.authMethod);
  if (!names || names.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      name: secrets.name,
      encryptedValue: secrets.encryptedValue,
      description: secrets.description,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, provider.orgId),
        eq(secrets.userId, provider.userId),
        eq(secrets.type, "model-provider"),
        inArray(secrets.name, [...names]),
      ),
    );
  return rows.map((row) => {
    return {
      name: row.name,
      encryptedValue: row.encryptedValue,
      description:
        row.description ?? `Personal ${provider.type} account secret`,
    };
  });
}

async function insertAccountSecrets(
  db: Db,
  accountId: string,
  encryptedSecrets: readonly EncryptedAccountSecret[],
): Promise<void> {
  if (encryptedSecrets.length === 0) {
    return;
  }
  await db.insert(modelProviderAccountSecrets).values(
    encryptedSecrets.map((secret) => {
      return {
        modelProviderAccountId: accountId,
        ...secret,
      };
    }),
  );
}

async function seedLegacyAccount(
  db: Db,
  provider: ProviderRow,
): Promise<AccountRow | null> {
  const encryptedSecrets = await legacySecretRows(db, provider);
  if (encryptedSecrets.length === 0) {
    return null;
  }
  const [account] = await db
    .insert(modelProviderAccounts)
    .values({
      modelProviderId: provider.id,
      orgId: provider.orgId,
      userId: provider.userId,
      type: provider.type,
      authMethod: provider.authMethod,
      isActive: true,
      workspaceName: provider.workspaceName,
      planType: provider.planType,
      tokenExpiresAt: provider.tokenExpiresAt,
      needsReconnect: provider.needsReconnect,
      lastRefreshErrorCode: provider.lastRefreshErrorCode,
      subscriptionResetPeriod: provider.subscriptionResetPeriod,
      subscriptionNextResetAt: provider.subscriptionNextResetAt,
    })
    .returning();
  if (!account) {
    throw new Error(
      "Expected personal model provider account insert to return",
    );
  }
  await insertAccountSecrets(db, account.id, encryptedSecrets);
  return account;
}

async function hydrateSeededCodexIdentity(args: {
  readonly db: Db;
  readonly account: AccountRow;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (args.account.type !== CODEX_TYPE) {
    return;
  }
  const rows = await args.db
    .select({
      name: modelProviderAccountSecrets.name,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
    })
    .from(modelProviderAccountSecrets)
    .where(
      and(
        eq(modelProviderAccountSecrets.modelProviderAccountId, args.account.id),
        inArray(modelProviderAccountSecrets.name, [
          CODEX_ACCOUNT_ID_SECRET,
          CODEX_ID_TOKEN_SECRET,
        ]),
      ),
    );
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(
      row.name,
      await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      ),
    );
  }
  await args.db
    .update(modelProviderAccounts)
    .set({
      externalAccountId: normalizedText(values.get(CODEX_ACCOUNT_ID_SECRET)),
      accountEmail: normalizedEmail(
        extractCodexAccountEmailFromIdToken(values.get(CODEX_ID_TOKEN_SECRET)),
      ),
      updatedAt: nowDate(),
    })
    .where(eq(modelProviderAccounts.id, args.account.id));
}

/**
 * Rollout fallback. Lazily expands the legacy singleton personal provider into
 * the first concrete account on read, so a user who already connected a
 * subscription before `PersonalModelProviderAccounts` sees it as an account.
 * Surface: DB/API, observed maximum exposure ~102 minutes for the deploy skew,
 * plus a read-time backfill tail over rows written before this PR. Remove once
 * every pre-feature personal provider has a `model_provider_accounts` row and
 * the seeding query returns zero candidates in production.
 */
export async function ensurePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly provider: ProviderRow;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<void> {
  if (!isPersonalSubscriptionProviderType(args.provider.type)) {
    return;
  }
  const [existing] = await args.db
    .select({ id: modelProviderAccounts.id })
    .from(modelProviderAccounts)
    .where(eq(modelProviderAccounts.modelProviderId, args.provider.id))
    .limit(1);
  if (existing) {
    return;
  }

  const seeded = await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.provider.orgId,
      userId: args.provider.userId,
      type: args.provider.type,
    });
    const [current] = await tx
      .select()
      .from(modelProviderAccounts)
      .where(eq(modelProviderAccounts.modelProviderId, args.provider.id))
      .limit(1);
    return current ?? (await seedLegacyAccount(tx, args.provider));
  });
  if (seeded) {
    await hydrateSeededCodexIdentity({
      db: args.db,
      account: seeded,
      featureSwitchContext: args.featureSwitchContext,
    });
  }
}

async function providerRowsForPersonalAccounts(
  db: Db,
  orgId: string,
  userId: string,
): Promise<readonly ProviderRow[]> {
  const rows = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        inArray(modelProviders.type, [CODEX_TYPE, CLAUDE_CODE_TYPE]),
      ),
    );
  return rows.filter((row) => {
    return isPersonalSubscriptionProviderType(row.type);
  });
}

export async function listPersonalModelProviderAccounts(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<ModelProviderListResponse> {
  const providers = await providerRowsForPersonalAccounts(
    args.db,
    args.orgId,
    args.userId,
  );
  for (const provider of providers) {
    await ensurePersonalModelProviderAccount({
      db: args.db,
      provider,
      featureSwitchContext: args.featureSwitchContext,
    });
  }

  const rows = await args.db
    .select({ account: modelProviderAccounts, provider: modelProviders })
    .from(modelProviderAccounts)
    .innerJoin(
      modelProviders,
      eq(modelProviderAccounts.modelProviderId, modelProviders.id),
    )
    .where(
      and(
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        inArray(modelProviderAccounts.type, [CODEX_TYPE, CLAUDE_CODE_TYPE]),
      ),
    )
    .orderBy(
      modelProviderAccounts.type,
      desc(modelProviderAccounts.isActive),
      asc(modelProviderAccounts.createdAt),
      asc(modelProviderAccounts.id),
    );
  return {
    modelProviders: rows.map((row) => {
      return accountResponse(row);
    }),
  };
}

function accountMetadataValues(args: {
  readonly type: PersonalSubscriptionProviderType;
  readonly metadata: PersonalProviderAccountMetadata | undefined;
  readonly secretValues: Readonly<Record<string, string>>;
}) {
  const externalAccountId =
    args.type === CODEX_TYPE
      ? normalizedText(
          args.metadata?.externalAccountId ??
            args.secretValues[CODEX_ACCOUNT_ID_SECRET],
        )
      : null;
  return {
    externalAccountId,
    accountEmail: normalizedEmail(args.metadata?.accountEmail),
    workspaceName: normalizedText(args.metadata?.workspaceName),
    planType: normalizedText(args.metadata?.planType),
    tokenExpiresAt: args.metadata?.tokenExpiresAt ?? null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    subscriptionResetPeriod: normalizedText(
      args.metadata?.subscriptionResetPeriod,
    ),
    subscriptionNextResetAt: args.metadata?.subscriptionNextResetAt ?? null,
    updatedAt: nowDate(),
  };
}

function sameClaudeIdentity(
  account: AccountRow,
  email: string | null,
  workspaceName: string | null,
): boolean {
  return (
    email !== null &&
    workspaceName !== null &&
    normalizedEmail(account.accountEmail) === email &&
    normalizedText(account.workspaceName)?.toLowerCase() ===
      workspaceName.toLowerCase()
  );
}

function identityMatches(
  account: AccountRow,
  type: PersonalSubscriptionProviderType,
  metadata: ReturnType<typeof accountMetadataValues>,
): boolean {
  if (type === CODEX_TYPE) {
    return (
      metadata.externalAccountId !== null &&
      account.externalAccountId === metadata.externalAccountId
    );
  }
  return sameClaudeIdentity(
    account,
    metadata.accountEmail,
    metadata.workspaceName,
  );
}

async function upsertLegacySecret(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly secret: EncryptedAccountSecret;
  },
): Promise<string> {
  const [row] = await db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.secret.name,
      encryptedValue: args.secret.encryptedValue,
      type: "model-provider",
      description: args.secret.description,
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      targetWhere: isNull(secrets.connectorId),
      set: {
        encryptedValue: args.secret.encryptedValue,
        description: args.secret.description,
        updatedAt: nowDate(),
      },
    })
    .returning({ id: secrets.id });
  if (!row) {
    throw new Error("Expected legacy model provider secret upsert to return");
  }
  return row.id;
}

/**
 * Rollout fallback. Keeps the pre-account `secrets` row and `model_providers`
 * row in sync with the active account so the credential path that predates
 * `PersonalModelProviderAccounts` still resolves. Surface: DB/API, observed
 * maximum exposure ~102 minutes, and additionally the whole time the switch can
 * still be turned back off for a user. Remove together with the legacy
 * single-secret read path once the switch is GA and every personal provider row
 * has been seeded into `model_provider_accounts`.
 */
async function mirrorAccountToLegacy(
  db: Db,
  args: {
    readonly account: AccountRow;
    readonly provider: ProviderRow;
  },
): Promise<void> {
  const accountSecrets = await db
    .select({
      name: modelProviderAccountSecrets.name,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
      description: modelProviderAccountSecrets.description,
    })
    .from(modelProviderAccountSecrets)
    .where(
      eq(modelProviderAccountSecrets.modelProviderAccountId, args.account.id),
    );
  let secretId: string | null = null;
  for (const secret of accountSecrets) {
    const id = await upsertLegacySecret(db, {
      orgId: args.account.orgId,
      userId: args.account.userId,
      secret: {
        ...secret,
        description:
          secret.description ??
          `Personal ${args.account.type} account secret: ${secret.name}`,
      },
    });
    if (
      getSecretNameForType(args.account.type as ModelProviderType) ===
      secret.name
    ) {
      secretId = id;
    }
  }
  await db
    .update(modelProviders)
    .set({
      authMethod: args.account.authMethod,
      secretId,
      tokenExpiresAt: args.account.tokenExpiresAt,
      needsReconnect: args.account.needsReconnect,
      lastRefreshErrorCode: args.account.lastRefreshErrorCode,
      workspaceName: args.account.workspaceName,
      planType: args.account.planType,
      subscriptionResetPeriod: args.account.subscriptionResetPeriod,
      subscriptionNextResetAt: args.account.subscriptionNextResetAt,
      updatedAt: nowDate(),
    })
    .where(eq(modelProviders.id, args.provider.id));
}

async function createLogicalProvider(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: PersonalSubscriptionProviderType;
    readonly selectedModel: string | undefined;
  },
): Promise<ProviderRow> {
  const [provider] = await db
    .insert(modelProviders)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
      isDefault: false,
      selectedModel: args.selectedModel ?? null,
    })
    .returning();
  if (!provider) {
    throw new Error("Expected logical model provider insert to return");
  }
  return provider;
}

function selectMutationTarget(args: {
  readonly accounts: readonly AccountRow[];
  readonly mode: PersonalProviderAccountMutation;
  readonly type: PersonalSubscriptionProviderType;
  readonly metadata: ReturnType<typeof accountMetadataValues>;
}): AccountRow | null | ReturnType<typeof notFound> {
  if (args.mode.kind === "reconnect") {
    const accountId = args.mode.accountId;
    return (
      args.accounts.find((account) => {
        return account.id === accountId;
      }) ?? notFound("Resource not found")
    );
  }
  if (args.mode.kind === "replace-active") {
    return (
      args.accounts.find((account) => {
        return account.isActive;
      }) ?? null
    );
  }
  return (
    args.accounts.find((account) => {
      return identityMatches(account, args.type, args.metadata);
    }) ?? null
  );
}

async function replaceAccountSecrets(
  db: Db,
  accountId: string,
  encryptedSecrets: readonly EncryptedAccountSecret[],
): Promise<void> {
  await db
    .delete(modelProviderAccountSecrets)
    .where(eq(modelProviderAccountSecrets.modelProviderAccountId, accountId));
  await insertAccountSecrets(db, accountId, encryptedSecrets);
}

async function applyAccountMutation(
  db: Db,
  args: {
    readonly provider: ProviderRow;
    readonly accounts: readonly AccountRow[];
    readonly type: PersonalSubscriptionProviderType;
    readonly authMethod: string | null;
    readonly mode: PersonalProviderAccountMutation;
    readonly metadata: ReturnType<typeof accountMetadataValues>;
    readonly encryptedSecrets: readonly EncryptedAccountSecret[];
  },
): Promise<
  | { readonly account: AccountRow; readonly created: boolean }
  | ReturnType<typeof notFound>
  | ReturnType<typeof badRequestMessage>
> {
  const selected = selectMutationTarget(args);
  if (selected && "status" in selected) {
    return selected;
  }
  if (!selected && args.accounts.length >= MAX_PERSONAL_PROVIDER_ACCOUNTS) {
    return badRequestMessage(
      `A maximum of ${MAX_PERSONAL_PROVIDER_ACCOUNTS} ${args.type} accounts can be connected`,
    );
  }

  const duplicateIds = selected
    ? args.accounts
        .filter((account) => {
          return (
            account.id !== selected.id &&
            identityMatches(account, args.type, args.metadata)
          );
        })
        .map((account) => {
          return account.id;
        })
    : [];
  const duplicateWasActive = args.accounts.some((account) => {
    return duplicateIds.includes(account.id) && account.isActive;
  });
  if (duplicateIds.length > 0) {
    await db
      .delete(modelProviderAccounts)
      .where(inArray(modelProviderAccounts.id, duplicateIds));
  }

  const shouldBeActive =
    selected?.isActive === true ||
    duplicateWasActive ||
    args.accounts.length === 0;
  let account: AccountRow;
  if (selected) {
    const [updated] = await db
      .update(modelProviderAccounts)
      .set({
        authMethod: args.authMethod,
        ...args.metadata,
        isActive: shouldBeActive,
      })
      .where(eq(modelProviderAccounts.id, selected.id))
      .returning();
    if (!updated) {
      throw new Error("Expected personal provider account update to return");
    }
    account = updated;
    await replaceAccountSecrets(db, account.id, args.encryptedSecrets);
  } else {
    const [inserted] = await db
      .insert(modelProviderAccounts)
      .values({
        modelProviderId: args.provider.id,
        orgId: args.provider.orgId,
        userId: args.provider.userId,
        type: args.type,
        authMethod: args.authMethod,
        isActive: shouldBeActive,
        ...args.metadata,
      })
      .returning();
    if (!inserted) {
      throw new Error("Expected personal provider account insert to return");
    }
    account = inserted;
    await insertAccountSecrets(db, account.id, args.encryptedSecrets);
  }

  if (account.isActive) {
    await db
      .update(modelProviderAccounts)
      .set({ isActive: false, updatedAt: nowDate() })
      .where(
        and(
          eq(modelProviderAccounts.modelProviderId, args.provider.id),
          ne(modelProviderAccounts.id, account.id),
          eq(modelProviderAccounts.isActive, true),
        ),
      );
    await mirrorAccountToLegacy(db, { account, provider: args.provider });
  }
  return { account, created: !selected };
}

export async function upsertPersonalModelProviderAccount(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly type: PersonalSubscriptionProviderType;
    readonly authMethod: string | null;
    readonly secretValues: Readonly<Record<string, string>>;
    readonly selectedModel?: string;
    readonly metadata?: PersonalProviderAccountMetadata;
    readonly mode: PersonalProviderAccountMutation;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | {
      readonly provider: ModelProviderResponse;
      readonly created: boolean;
    }
> {
  const encryptedSecrets = await encryptAccountSecrets(
    args.type,
    args.secretValues,
    args.featureSwitchContext,
    signal,
  );
  const existingProviders = await providerRowsForPersonalAccounts(
    args.db,
    args.orgId,
    args.userId,
  );
  const existingProvider = existingProviders.find((provider) => {
    return provider.type === args.type;
  });
  if (existingProvider) {
    await ensurePersonalModelProviderAccount({
      db: args.db,
      provider: existingProvider,
      featureSwitchContext: args.featureSwitchContext,
    });
  }
  signal.throwIfAborted();

  return await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: args.type,
    });
    signal.throwIfAborted();
    const [providerRow] = await tx
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.type, args.type),
        ),
      )
      .limit(1);
    const provider =
      providerRow ??
      (await createLogicalProvider(tx, {
        orgId: args.orgId,
        userId: args.userId,
        type: args.type,
        selectedModel: args.selectedModel,
      }));
    const accounts = await tx
      .select()
      .from(modelProviderAccounts)
      .where(eq(modelProviderAccounts.modelProviderId, provider.id))
      .orderBy(
        asc(modelProviderAccounts.createdAt),
        asc(modelProviderAccounts.id),
      );
    const metadata = accountMetadataValues({
      type: args.type,
      metadata: args.metadata,
      secretValues: args.secretValues,
    });
    const result = await applyAccountMutation(tx, {
      provider,
      accounts,
      type: args.type,
      authMethod: args.authMethod,
      mode: args.mode,
      metadata,
      encryptedSecrets,
    });
    if ("status" in result) {
      return result;
    }
    return {
      provider: accountResponse({ account: result.account, provider }),
      created: result.created,
    };
  });
}

async function accountWithProvider(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly id: string;
  },
): Promise<{
  readonly account: AccountRow;
  readonly provider: ProviderRow;
} | null> {
  const [row] = await db
    .select({ account: modelProviderAccounts, provider: modelProviders })
    .from(modelProviderAccounts)
    .innerJoin(
      modelProviders,
      eq(modelProviderAccounts.modelProviderId, modelProviders.id),
    )
    .where(
      and(
        eq(modelProviderAccounts.id, args.id),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function activatePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly id: string;
}): Promise<ModelProviderResponse | ReturnType<typeof notFound>> {
  const initial = await accountWithProvider(args.db, args);
  if (!initial || !isPersonalSubscriptionProviderType(initial.account.type)) {
    return notFound("Resource not found");
  }
  return await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: initial.account.type,
    });
    const current = await accountWithProvider(tx, args);
    if (!current) {
      return notFound("Resource not found");
    }
    await tx
      .update(modelProviderAccounts)
      .set({ isActive: false, updatedAt: nowDate() })
      .where(eq(modelProviderAccounts.modelProviderId, current.provider.id));
    const [account] = await tx
      .update(modelProviderAccounts)
      .set({ isActive: true, updatedAt: nowDate() })
      .where(eq(modelProviderAccounts.id, current.account.id))
      .returning();
    if (!account) {
      throw new Error("Expected activated model provider account to return");
    }
    await mirrorAccountToLegacy(tx, { account, provider: current.provider });
    return accountResponse({ account, provider: current.provider });
  });
}

async function deleteLastAccount(
  db: Db,
  args: { readonly account: AccountRow; readonly provider: ProviderRow },
): Promise<void> {
  const legacyNames = args.account.authMethod
    ? getSecretNamesForAuthMethod(
        args.account.type as ModelProviderType,
        args.account.authMethod,
      )
    : [getSecretNameForType(args.account.type as ModelProviderType)].filter(
        (name): name is string => {
          return name !== undefined;
        },
      );
  await db
    .delete(modelProviders)
    .where(eq(modelProviders.id, args.provider.id));
  if (legacyNames && legacyNames.length > 0) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.account.orgId),
          eq(secrets.userId, args.account.userId),
          eq(secrets.type, "model-provider"),
          inArray(secrets.name, [...legacyNames]),
        ),
      );
  }
}

export async function deletePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly id: string;
}): Promise<ReturnType<typeof notFound> | undefined> {
  const initial = await accountWithProvider(args.db, args);
  if (!initial || !isPersonalSubscriptionProviderType(initial.account.type)) {
    return notFound("Resource not found");
  }
  return await args.db.transaction(async (tx) => {
    await lockModelProviderState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: initial.account.type,
    });
    const current = await accountWithProvider(tx, args);
    if (!current) {
      return notFound("Resource not found");
    }
    await tx
      .delete(modelProviderAccounts)
      .where(eq(modelProviderAccounts.id, current.account.id));
    const [replacement] = await tx
      .select()
      .from(modelProviderAccounts)
      .where(eq(modelProviderAccounts.modelProviderId, current.provider.id))
      .orderBy(
        asc(modelProviderAccounts.needsReconnect),
        asc(modelProviderAccounts.createdAt),
        asc(modelProviderAccounts.id),
      )
      .limit(1);
    if (!replacement) {
      await deleteLastAccount(tx, current);
      return undefined;
    }
    if (current.account.isActive) {
      const [active] = await tx
        .update(modelProviderAccounts)
        .set({ isActive: true, updatedAt: nowDate() })
        .where(eq(modelProviderAccounts.id, replacement.id))
        .returning();
      if (!active) {
        throw new Error(
          "Expected replacement model provider account to return",
        );
      }
      await mirrorAccountToLegacy(tx, {
        account: active,
        provider: current.provider,
      });
    }
    return undefined;
  });
}

export async function activePersonalModelProviderAccount(args: {
  readonly db: Db;
  readonly modelProviderId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<AccountRow | null> {
  const [account] = await args.db
    .select()
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.modelProviderId, args.modelProviderId),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.isActive, true),
      ),
    )
    .limit(1);
  return account ?? null;
}

/**
 * Capture the concrete ChatGPT account selected for one run admission.
 *
 * A non-null candidate can name either the logical provider row or an already
 * captured account row. Unknown/stale explicit IDs fail closed instead of
 * falling back to whichever sibling account is active.
 */
export async function captureActiveCodexModelProviderAccount(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string | null;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<AccountRow | null> {
  if (args.modelProviderId !== null) {
    const exactAccount = await personalModelProviderAccountById({
      db: args.db,
      id: args.modelProviderId,
      orgId: args.orgId,
      userId: args.userId,
    });
    if (exactAccount) {
      return exactAccount.type === CODEX_TYPE ? exactAccount : null;
    }
  }

  const [provider] = await args.db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        eq(modelProviders.userId, args.userId),
        eq(modelProviders.type, CODEX_TYPE),
        ...(args.modelProviderId === null
          ? []
          : [eq(modelProviders.id, args.modelProviderId)]),
      ),
    )
    .limit(1);
  if (!provider) {
    return null;
  }
  await ensurePersonalModelProviderAccount({
    db: args.db,
    provider,
    featureSwitchContext: args.featureSwitchContext,
  });
  const account = await activePersonalModelProviderAccount({
    db: args.db,
    modelProviderId: provider.id,
    orgId: args.orgId,
    userId: args.userId,
  });
  return account?.type === CODEX_TYPE ? account : null;
}

export async function personalModelProviderAccountById(args: {
  readonly db: Db;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<AccountRow | null> {
  const [account] = await args.db
    .select()
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.id, args.id),
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
      ),
    )
    .limit(1);
  return account ?? null;
}
