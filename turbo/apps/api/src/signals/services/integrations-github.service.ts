import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { command, computed } from "ccstate";
import type { GithubInstallationResponse } from "@vm0/api-contracts/contracts/integrations-github";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { eq } from "drizzle-orm";

import { authContext$ } from "../auth/auth-context";
import { db$, writeDb$ } from "../external/db";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { zeroConnectorList } from "./zero-connector-data.service";
import { userSecrets, userVariables } from "./zero-user-data.service";

const INSTALLATION_ID_RE = /^\d+$/;
const L = logger("IntegrationsGithub");

function errorResponse(
  status: 400 | 401 | 403 | 404 | 500,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function githubInstallUrl(userId: string): string | null {
  if (!optionalEnv("GITHUB_APP_SLUG")) {
    return null;
  }

  const url = new URL("/api/github/oauth/install", env("VM0_API_URL"));
  url.searchParams.set("vm0UserId", userId);
  return url.toString();
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

  await deleteRemoteGithubInstallation({
    appId,
    privateKey,
    installationId: args.installationId,
    signal: args.signal,
  }).catch((error: unknown) => {
    L.error("Failed to delete GitHub installation", { error });
  });
  args.signal.throwIfAborted();
}

export const deleteGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const db = set(writeDb$);

    const [result] = await db
      .select({
        id: githubInstallations.id,
        githubInstallationId: githubInstallations.installationId,
        adminGithubUserId: githubInstallations.adminGithubUserId,
        githubUserId: githubUserLinks.githubUserId,
      })
      .from(githubUserLinks)
      .innerJoin(
        githubInstallations,
        eq(githubInstallations.id, githubUserLinks.installationId),
      )
      .where(eq(githubUserLinks.vm0UserId, auth.userId))
      .limit(1);
    signal.throwIfAborted();

    if (!result) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    if (
      !result.adminGithubUserId ||
      result.githubUserId !== result.adminGithubUserId
    ) {
      return errorResponse(
        403,
        "Only the installation admin can uninstall",
        "FORBIDDEN",
      );
    }

    await deleteRemoteGithubInstallationIfConfigured({
      installationId: result.githubInstallationId,
      signal,
    });

    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, result.id));
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const getGithubInstallation$ = computed(async (get) => {
  const auth = get(authContext$);
  const db = get(db$);

  const [result] = await db
    .select({
      installation: {
        id: githubInstallations.id,
        installationId: githubInstallations.installationId,
        status: githubInstallations.status,
        targetName: githubInstallations.targetName,
        targetType: githubInstallations.targetType,
        adminGithubUserId: githubInstallations.adminGithubUserId,
        defaultComposeId: githubInstallations.defaultComposeId,
      },
      githubUserId: githubUserLinks.githubUserId,
    })
    .from(githubUserLinks)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubUserLinks.installationId),
    )
    .where(eq(githubUserLinks.vm0UserId, auth.userId))
    .limit(1);

  if (!result) {
    return {
      status: 404 as const,
      body: {
        error: {
          message: "No GitHub installation found",
          code: "NOT_FOUND",
        },
        installUrl: githubInstallUrl(auth.userId),
      },
    };
  }

  const installation = result.installation;
  const isAdmin =
    installation.adminGithubUserId !== null &&
    result.githubUserId === installation.adminGithubUserId;

  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  let environment = emptyEnvironment();

  if (compose?.headVersionId) {
    const [version] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version) {
      const grouped = extractAndGroupVariables(version.content);
      environment = {
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
  }

  if (!auth.orgId) {
    return errorResponse(
      400,
      "Explicit org context required — ensure active org in session",
      "BAD_REQUEST",
    );
  }

  const [secretList, variableList, connectorList] = await Promise.all([
    get(userSecrets({ orgId: auth.orgId, userId: auth.userId })),
    get(userVariables({ orgId: auth.orgId, userId: auth.userId })),
    get(zeroConnectorList({ orgId: auth.orgId, userId: auth.userId })),
  ]);

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

  const body: GithubInstallationResponse = {
    installation: {
      id: installation.id,
      installationId: installation.installationId,
      status: installation.status,
      targetName: installation.targetName,
      targetType: installation.targetType,
      isAdmin,
    },
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
  };

  return { status: 200 as const, body };
});
