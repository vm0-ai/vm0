import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { command } from "ccstate";
import type {
  GithubConnectUserBody,
  CreateGithubLabelListenerBody,
  GithubInstallationResponse,
  GithubLabelListener,
  UpdateGithubLabelListenerBody,
} from "@vm0/api-contracts/contracts/integrations-github";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import {
  githubLabelListeners,
  type GithubLabelTriggerMode,
} from "@vm0/db/schema/github-label-listener";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, asc, eq, ne } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { tapError } from "../utils";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { getOAuthWebOrigin } from "../routes/oauth-web-origin";
import {
  buildGithubOauthState,
  buildGithubUserConnectAuthorizationUrl,
  findGithubInstallationByInstallationId,
  linkGithubVm0User,
  verifyGithubConnectSignature,
} from "./github-oauth.service";
import { zeroConnectorList } from "./zero-connector-data.service";
import { userSecrets, userVariables } from "./zero-user-data.service";

const INSTALLATION_ID_RE = /^\d+$/;
const L = logger("IntegrationsGithub");

function errorResponse(
  status: 400 | 401 | 403 | 404 | 409 | 500,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function githubAppSetupCallbackRedirectUri(origin: string): string {
  return `${origin}/api/github/app/setup/callback`;
}

async function githubInstallUrl(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string | null;
  readonly origin: string;
}): Promise<string | null> {
  const appSlug = optionalEnv("GITHUB_APP_SLUG");
  if (!appSlug) {
    return null;
  }

  const state = await buildGithubOauthState({
    vm0UserId: args.userId,
    orgId: args.orgId,
    composeId: args.composeId ?? undefined,
    secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
  });
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  if (state) {
    url.searchParams.set("state", state);
  }
  url.searchParams.set(
    "redirect_uri",
    githubAppSetupCallbackRedirectUri(args.origin),
  );
  return url.toString();
}

function githubConnectStartUrl(origin: string): string {
  return `${origin}/api/zero/github/oauth/connect`;
}

async function publishGithubChanged(userIds: readonly string[]): Promise<void> {
  const uniqueUserIds = Array.from(new Set(userIds));
  if (uniqueUserIds.length === 0) {
    return;
  }

  await tapError(
    publishUserSignal(uniqueUserIds, "github:changed"),
    (error) => {
      L.warn("Failed to publish GitHub integration changed signal", {
        userIds: uniqueUserIds,
        error,
      });
    },
  );
}

function emptyEnvironment(): GithubInstallationResponse["environment"] {
  return {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  };
}

function validateInstallationId(installationId: string): string {
  if (!INSTALLATION_ID_RE.test(installationId)) {
    throw new Error(
      `Invalid GitHub installation ID: expected numeric string, got "${installationId}"`,
    );
  }
  return installationId;
}

function base64url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parsePemKey(input: string): string {
  if (!input.startsWith("-----BEGIN")) {
    return Buffer.from(input, "base64").toString("utf8");
  }

  const match = input.match(
    /^(-----BEGIN [^-]+-----)[\s]+([\s\S]+?)[\s]+(-----END [^-]+-----)$/,
  );
  if (!match) {
    return input;
  }

  const header = match[1];
  const bodyMatch = match[2];
  const footer = match[3];
  if (!header || !bodyMatch || !footer) {
    return input;
  }

  const body = bodyMatch.replace(/\s+/g, "\n");
  return `${header}\n${body}\n${footer}\n`;
}

function createAppJwt(appId: string, privateKeyPemOrBase64: string): string {
  const nowSeconds = Math.floor(now() / 1000);
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 600,
      iss: appId,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(
    parsePemKey(privateKeyPemOrBase64),
    "base64url",
  );

  return `${signingInput}.${signature}`;
}

async function deleteRemoteGithubInstallation(args: {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const installationId = validateInstallationId(args.installationId);
  const jwt = createAppJwt(args.appId, args.privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: args.signal,
    },
  );

  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(
      `Failed to delete installation: ${response.status} ${body}`,
    );
  }
}

async function deleteRemoteGithubInstallationIfConfigured(args: {
  readonly installationId: string | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey || !args.installationId) {
    return;
  }

  await tapError(
    deleteRemoteGithubInstallation({
      appId,
      privateKey,
      installationId: args.installationId,
      signal: args.signal,
    }),
    (error) => {
      L.error("Failed to delete GitHub installation", { error });
    },
  );
  args.signal.throwIfAborted();
}

type GitHubInstallationRecord = typeof githubInstallations.$inferSelect;

interface GitHubUserLinkRecord {
  readonly githubUserId: string;
}

interface ComposeSummary {
  readonly id: string;
  readonly name: string;
  readonly headVersionId: string | null;
}

interface ListenerRow {
  readonly id: string;
  readonly labelName: string;
  readonly triggerMode: GithubLabelTriggerMode;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdByUserId: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
}

function normalizeLabelName(labelName: string): string {
  return labelName.trim().toLowerCase();
}

function canManageInstallation(args: {
  readonly orgRole: string | undefined;
}): boolean {
  return args.orgRole === "admin";
}

function canManageLabelListener(args: {
  readonly createdByUserId: string;
  readonly userId: string;
  readonly orgRole: string | undefined;
}): boolean {
  return (
    canManageInstallation({ orgRole: args.orgRole }) ||
    args.createdByUserId === args.userId
  );
}

function serializeListener(
  row: ListenerRow,
  args: {
    readonly userId: string;
    readonly orgRole: string | undefined;
  },
): GithubLabelListener {
  return {
    id: row.id,
    labelName: row.labelName,
    triggerMode: row.triggerMode,
    prompt: row.prompt,
    enabled: row.enabled,
    canManage: canManageLabelListener({
      createdByUserId: row.createdByUserId,
      userId: args.userId,
      orgRole: args.orgRole,
    }),
    agent:
      row.agentId && row.agentName
        ? { id: row.agentId, name: row.agentName }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadOrgDefaultComposeId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return orgRow?.defaultAgentId ?? null;
}

async function loadOrgGithubInstallation(
  db: ReadonlyDb,
  orgId: string,
): Promise<GitHubInstallationRecord | null> {
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);

  return installation ?? null;
}

async function loadUserGithubLink(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly userId: string;
}): Promise<GitHubUserLinkRecord | null> {
  const [link] = await args.db
    .select({ githubUserId: githubUserLinks.githubUserId })
    .from(githubUserLinks)
    .where(
      and(
        eq(githubUserLinks.installationId, args.installationId),
        eq(githubUserLinks.vm0UserId, args.userId),
      ),
    )
    .limit(1);

  return link ?? null;
}

async function loadComposeSummary(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly composeId: string;
}): Promise<ComposeSummary | null> {
  const [compose] = await args.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.id, args.composeId),
      ),
    )
    .limit(1);

  return compose ?? null;
}

async function loadComposeByName(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly agentName: string;
}): Promise<{ readonly id: string } | null> {
  const [compose] = await args.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.name, args.agentName),
      ),
    )
    .limit(1);

  return compose ?? null;
}

async function buildEnvironment(args: {
  readonly db: ReadonlyDb;
  readonly compose: ComposeSummary | null;
}): Promise<GithubInstallationResponse["environment"]> {
  if (!args.compose?.headVersionId) {
    return emptyEnvironment();
  }

  const [version] = await args.db
    .select({ content: agentComposeVersions.content })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, args.compose.headVersionId))
    .limit(1);

  if (!version) {
    return emptyEnvironment();
  }

  const grouped = extractAndGroupVariables(version.content);
  return {
    requiredSecrets: grouped.secrets.map((secret) => {
      return secret.name;
    }),
    requiredVars: grouped.vars.map((variable) => {
      return variable.name;
    }),
    missingSecrets: [],
    missingVars: [],
  };
}

async function loadListeners(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly userId: string;
  readonly orgRole: string | undefined;
}): Promise<readonly GithubLabelListener[]> {
  const rows = await args.db
    .select({
      id: githubLabelListeners.id,
      labelName: githubLabelListeners.labelName,
      triggerMode: githubLabelListeners.triggerMode,
      prompt: githubLabelListeners.prompt,
      enabled: githubLabelListeners.enabled,
      createdAt: githubLabelListeners.createdAt,
      updatedAt: githubLabelListeners.updatedAt,
      createdByUserId: githubLabelListeners.createdByUserId,
      agentId: agentComposes.id,
      agentName: agentComposes.name,
    })
    .from(githubLabelListeners)
    .leftJoin(
      agentComposes,
      eq(agentComposes.id, githubLabelListeners.composeId),
    )
    .where(eq(githubLabelListeners.installationId, args.installationId))
    .orderBy(asc(githubLabelListeners.labelNameNormalized));

  return rows.map((row) => {
    return serializeListener(row, {
      userId: args.userId,
      orgRole: args.orgRole,
    });
  });
}

async function loadListener(args: {
  readonly db: ReadonlyDb;
  readonly listenerId: string;
  readonly orgId: string;
}): Promise<(ListenerRow & { readonly installationId: string }) | null> {
  const [row] = await args.db
    .select({
      id: githubLabelListeners.id,
      installationId: githubLabelListeners.installationId,
      createdByUserId: githubLabelListeners.createdByUserId,
      labelName: githubLabelListeners.labelName,
      triggerMode: githubLabelListeners.triggerMode,
      prompt: githubLabelListeners.prompt,
      enabled: githubLabelListeners.enabled,
      createdAt: githubLabelListeners.createdAt,
      updatedAt: githubLabelListeners.updatedAt,
      agentId: agentComposes.id,
      agentName: agentComposes.name,
    })
    .from(githubLabelListeners)
    .leftJoin(
      agentComposes,
      eq(agentComposes.id, githubLabelListeners.composeId),
    )
    .where(
      and(
        eq(githubLabelListeners.id, args.listenerId),
        eq(githubLabelListeners.orgId, args.orgId),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function listenerLabelExists(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly labelNameNormalized: string;
  readonly exceptListenerId?: string;
}): Promise<boolean> {
  const filters = [
    eq(githubLabelListeners.installationId, args.installationId),
    eq(githubLabelListeners.labelNameNormalized, args.labelNameNormalized),
  ];
  if (args.exceptListenerId) {
    filters.push(ne(githubLabelListeners.id, args.exceptListenerId));
  }

  const [existing] = await args.db
    .select({ id: githubLabelListeners.id })
    .from(githubLabelListeners)
    .where(and(...filters))
    .limit(1);

  return Boolean(existing);
}

async function validateTriggerModeLink(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly userId: string;
  readonly triggerMode: GithubLabelTriggerMode;
}): Promise<boolean> {
  if (args.triggerMode !== "created_by_me") {
    return true;
  }

  const link = await loadUserGithubLink({
    db: args.db,
    installationId: args.installationId,
    userId: args.userId,
  });
  return link !== null;
}

async function loadCreatedListener(args: {
  readonly db: ReadonlyDb;
  readonly listenerId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole: string | undefined;
}): Promise<GithubLabelListener> {
  const listener = await loadListener({
    db: args.db,
    listenerId: args.listenerId,
    orgId: args.orgId,
  });

  if (!listener) {
    throw new Error(`GitHub label listener not found: ${args.listenerId}`);
  }

  return serializeListener(listener, {
    userId: args.userId,
    orgRole: args.orgRole,
  });
}

export const connectGithubUser$ = command(
  async ({ get, set }, body: GithubConnectUserBody, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const connectSignature = body?.connectSignature;
    if (
      connectSignature &&
      !verifyGithubConnectSignature({
        installationId: connectSignature.installationId,
        githubUserId: connectSignature.githubUserId,
        githubUsername: connectSignature.githubUsername,
        timestamp: connectSignature.timestamp,
        signature: connectSignature.signature,
        secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
      })
    ) {
      return errorResponse(
        400,
        "Invalid or expired GitHub connect link",
        "INVALID_CONNECT_LINK",
      );
    }

    const installation = connectSignature
      ? await findGithubInstallationByInstallationId({
          db,
          installationId: connectSignature.installationId,
          orgId: auth.orgId,
          signal,
        })
      : await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();

    if (!installation) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    const githubUserId = await linkGithubVm0User({
      db,
      installRecordId: installation.id,
      vm0UserId: auth.userId,
      knownGithubUserId: connectSignature?.githubUserId,
      signal,
    });
    signal.throwIfAborted();

    if (!githubUserId) {
      return connectSignature
        ? errorResponse(
            409,
            "This GitHub account is already linked to the installation",
            "GITHUB_ACCOUNT_ALREADY_LINKED",
          )
        : errorResponse(
            409,
            "Connect your GitHub account before linking this installation",
            "GITHUB_ACCOUNT_REQUIRED",
          );
    }

    await publishGithubChanged([auth.userId]);
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const disconnectGithubUser$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const installation = await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();

    if (!installation) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    await db
      .delete(githubUserLinks)
      .where(
        and(
          eq(githubUserLinks.installationId, installation.id),
          eq(githubUserLinks.vm0UserId, auth.userId),
        ),
      );
    signal.throwIfAborted();

    await publishGithubChanged([auth.userId]);
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const deleteGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const installation = await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();

    if (!installation) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    if (!canManageInstallation({ orgRole: auth.orgRole })) {
      return errorResponse(
        403,
        "Only organization admins can uninstall GitHub",
        "FORBIDDEN",
      );
    }

    const linkedUsers = await db
      .select({ vm0UserId: githubUserLinks.vm0UserId })
      .from(githubUserLinks)
      .where(eq(githubUserLinks.installationId, installation.id));
    signal.throwIfAborted();

    await deleteRemoteGithubInstallationIfConfigured({
      installationId: installation.installationId,
      signal,
    });

    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, installation.id));
    signal.throwIfAborted();

    await publishGithubChanged([
      auth.userId,
      ...linkedUsers.map((link) => {
        return link.vm0UserId;
      }),
    ]);
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const updateGithubInstallation$ = command(
  async (
    { get, set },
    args: { readonly agentName: string },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const installation = await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();

    if (!installation) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    if (!canManageInstallation({ orgRole: auth.orgRole })) {
      return errorResponse(
        403,
        "Only organization admins can change the default agent",
        "FORBIDDEN",
      );
    }

    const compose = await loadComposeByName({
      db,
      orgId: auth.orgId,
      agentName: args.agentName,
    });
    signal.throwIfAborted();

    if (!compose) {
      return errorResponse(404, "Agent not found", "NOT_FOUND");
    }

    await db
      .update(githubInstallations)
      .set({ defaultComposeId: compose.id, updatedAt: nowDate() })
      .where(eq(githubInstallations.id, installation.id));
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const createGithubLabelListener$ = command(
  async (
    { get, set },
    args: CreateGithubLabelListenerBody,
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const installation = await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();

    if (!installation) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    const labelName = args.labelName.trim();
    const labelNameNormalized = normalizeLabelName(args.labelName);
    const prompt = args.prompt.trim();
    if (!labelName || !labelNameNormalized || !prompt) {
      return errorResponse(
        400,
        "Label name and prompt are required",
        "BAD_REQUEST",
      );
    }

    const compose = await loadComposeSummary({
      db,
      orgId: auth.orgId,
      composeId: args.agentId,
    });
    signal.throwIfAborted();

    if (!compose) {
      return errorResponse(404, "Agent not found", "NOT_FOUND");
    }

    if (
      !(await validateTriggerModeLink({
        db,
        installationId: installation.id,
        userId: auth.userId,
        triggerMode: args.triggerMode,
      }))
    ) {
      return errorResponse(
        409,
        "Connect your GitHub account before using the created-by-me trigger mode",
        "GITHUB_ACCOUNT_REQUIRED",
      );
    }
    signal.throwIfAborted();

    if (
      await listenerLabelExists({
        db,
        installationId: installation.id,
        labelNameNormalized,
      })
    ) {
      return errorResponse(
        409,
        "A listener for this label already exists",
        "DUPLICATE_LABEL",
      );
    }
    signal.throwIfAborted();

    const [listener] = await db
      .insert(githubLabelListeners)
      .values({
        installationId: installation.id,
        orgId: auth.orgId,
        createdByUserId: auth.userId,
        labelName,
        labelNameNormalized,
        triggerMode: args.triggerMode,
        prompt,
        composeId: compose.id,
        enabled: args.enabled ?? true,
      })
      .returning({ id: githubLabelListeners.id });
    signal.throwIfAborted();

    if (!listener) {
      throw new Error("Expected GitHub label listener insert to return a row");
    }

    return {
      status: 201 as const,
      body: {
        listener: await loadCreatedListener({
          db,
          listenerId: listener.id,
          orgId: auth.orgId,
          userId: auth.userId,
          orgRole: auth.orgRole,
        }),
      },
    };
  },
);

export const updateGithubLabelListener$ = command(
  async (
    { get, set },
    args: {
      readonly listenerId: string;
      readonly body: UpdateGithubLabelListenerBody;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const existing = await loadListener({
      db,
      listenerId: args.listenerId,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();

    if (!existing) {
      return errorResponse(404, "GitHub label listener not found", "NOT_FOUND");
    }

    if (
      !canManageLabelListener({
        createdByUserId: existing.createdByUserId,
        userId: auth.userId,
        orgRole: auth.orgRole,
      })
    ) {
      return errorResponse(
        403,
        "Only the label listener owner or an org admin can update this listener",
        "FORBIDDEN",
      );
    }

    const values: Partial<typeof githubLabelListeners.$inferInsert> = {
      updatedAt: nowDate(),
    };

    if (args.body.labelName !== undefined) {
      const labelName = args.body.labelName.trim();
      const labelNameNormalized = normalizeLabelName(args.body.labelName);
      if (!labelName || !labelNameNormalized) {
        return errorResponse(400, "Label name is required", "BAD_REQUEST");
      }
      if (
        await listenerLabelExists({
          db,
          installationId: existing.installationId,
          labelNameNormalized,
          exceptListenerId: existing.id,
        })
      ) {
        return errorResponse(
          409,
          "A listener for this label already exists",
          "DUPLICATE_LABEL",
        );
      }
      values.labelName = labelName;
      values.labelNameNormalized = labelNameNormalized;
    }

    if (args.body.prompt !== undefined) {
      const prompt = args.body.prompt.trim();
      if (!prompt) {
        return errorResponse(400, "Prompt is required", "BAD_REQUEST");
      }
      values.prompt = prompt;
    }

    if (args.body.agentId !== undefined) {
      const compose = await loadComposeSummary({
        db,
        orgId: auth.orgId,
        composeId: args.body.agentId,
      });
      signal.throwIfAborted();
      if (!compose) {
        return errorResponse(404, "Agent not found", "NOT_FOUND");
      }
      values.composeId = compose.id;
    }

    const nextTriggerMode = args.body.triggerMode ?? existing.triggerMode;
    if (
      !(await validateTriggerModeLink({
        db,
        installationId: existing.installationId,
        userId: existing.createdByUserId,
        triggerMode: nextTriggerMode,
      }))
    ) {
      return errorResponse(
        409,
        "Connect your GitHub account before using the created-by-me trigger mode",
        "GITHUB_ACCOUNT_REQUIRED",
      );
    }
    values.triggerMode = nextTriggerMode;

    if (args.body.enabled !== undefined) {
      values.enabled = args.body.enabled;
    }

    await db
      .update(githubLabelListeners)
      .set(values)
      .where(eq(githubLabelListeners.id, existing.id));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        listener: await loadCreatedListener({
          db,
          listenerId: existing.id,
          orgId: auth.orgId,
          userId: auth.userId,
          orgRole: auth.orgRole,
        }),
      },
    };
  },
);

export const deleteGithubLabelListener$ = command(
  async (
    { get, set },
    args: { readonly listenerId: string },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const db = set(writeDb$);
    const existing = await loadListener({
      db,
      listenerId: args.listenerId,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();

    if (!existing) {
      return errorResponse(404, "GitHub label listener not found", "NOT_FOUND");
    }

    if (
      !canManageLabelListener({
        createdByUserId: existing.createdByUserId,
        userId: auth.userId,
        orgRole: auth.orgRole,
      })
    ) {
      return errorResponse(
        403,
        "Only the label listener owner or an org admin can delete this listener",
        "FORBIDDEN",
      );
    }

    await db
      .delete(githubLabelListeners)
      .where(eq(githubLabelListeners.id, existing.id));
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const getGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const origin = getOAuthWebOrigin(get(request$).raw);
    const db = set(writeDb$);
    const installation = await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();
    const defaultComposeId = await loadOrgDefaultComposeId(db, auth.orgId);
    signal.throwIfAborted();
    const installUrl =
      auth.orgRole === "admin"
        ? await githubInstallUrl({
            userId: auth.userId,
            orgId: auth.orgId,
            composeId: defaultComposeId,
            origin,
          })
        : null;
    signal.throwIfAborted();

    if (!installation) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "No GitHub installation found",
            code: "NOT_FOUND",
          },
          installUrl,
        },
      };
    }

    const link = await loadUserGithubLink({
      db,
      installationId: installation.id,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    const isAdmin = canManageInstallation({ orgRole: auth.orgRole });
    const compose = await loadComposeSummary({
      db,
      orgId: auth.orgId,
      composeId: installation.defaultComposeId,
    });
    signal.throwIfAborted();
    const environment = await buildEnvironment({ db, compose });
    signal.throwIfAborted();

    const [secretList, variableList, connectorList, labelListeners] =
      await Promise.all([
        get(userSecrets({ orgId: auth.orgId, userId: auth.userId })),
        get(userVariables({ orgId: auth.orgId, userId: auth.userId })),
        get(zeroConnectorList({ orgId: auth.orgId, userId: auth.userId })),
        loadListeners({
          db,
          installationId: installation.id,
          userId: auth.userId,
          orgRole: auth.orgRole,
        }),
      ]);
    signal.throwIfAborted();

    const connectorProvided = getConnectorProvidedSecretNames(
      connectorList.connectors.map((connector) => {
        return connector.type;
      }),
    );
    const existingSecretNames = new Set([
      ...secretList.secrets.map((secret) => {
        return secret.name;
      }),
      ...connectorProvided,
    ]);
    const existingVarNames = new Set(
      variableList.variables.map((variable) => {
        return variable.name;
      }),
    );
    const githubConnector =
      connectorList.connectors.find((connector) => {
        return connector.type === "github";
      }) ?? null;
    const connectUrl =
      link === null
        ? ((await buildGithubUserConnectAuthorizationUrl({
            db,
            vm0UserId: auth.userId,
            orgId: auth.orgId,
            origin,
            readEnv: optionalEnv,
            signal,
          })) ?? githubConnectStartUrl(origin))
        : githubConnectStartUrl(origin);
    signal.throwIfAborted();

    const body: GithubInstallationResponse = {
      installation: {
        id: installation.id,
        installationId: installation.installationId,
        status: installation.status,
        targetName: installation.targetName,
        targetType: installation.targetType,
        isAdmin,
      },
      isConnected: link !== null,
      connectedGithubUserId: link?.githubUserId ?? null,
      connectedGithubUsername: link
        ? (githubConnector?.externalUsername ?? null)
        : null,
      installUrl,
      connectUrl,
      agent: compose ? { id: compose.id, name: compose.name } : null,
      environment: {
        ...environment,
        missingSecrets: environment.requiredSecrets.filter((name) => {
          return !existingSecretNames.has(name);
        }),
        missingVars: environment.requiredVars.filter((name) => {
          return !existingVarNames.has(name);
        }),
      },
      labelListeners: [...labelListeners],
    };

    return { status: 200 as const, body };
  },
);
