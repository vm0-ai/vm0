import { command } from "ccstate";
import type {
  GithubConnectUserBody,
  GithubInstallationResponse,
} from "@vm0/api-contracts/contracts/integrations-github";
import { connectors } from "@vm0/db/schema/connector";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import { getOAuthWebOrigin } from "../routes/oauth-web-origin";
import {
  buildGithubAppInstallUrl,
  buildGithubUserConnectAuthorizationUrl,
  findGithubInstallationByInstallationId,
  getGithubOAuthAuthMethod,
  linkGithubVm0User,
  verifyGithubConnectSignature,
} from "./github-oauth.service";
import { connectorActionResolver } from "./connector-action-resolver.service";

function errorResponse(status: 400 | 404 | 409, message: string, code: string) {
  return { status, body: { error: { message, code } } };
}

function githubConnectStartUrl(origin: string): string {
  return `${origin}/api/zero/github/oauth/connect`;
}

async function githubInstallUrl(args: {
  readonly db: ReadonlyDb;
  readonly userId: string;
  readonly orgId: string;
  readonly origin: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const appSlug = optionalEnv("GITHUB_APP_SLUG");
  if (!appSlug) {
    return null;
  }

  const composeId = await loadOrgDefaultComposeId(args.db, args.orgId);
  args.signal.throwIfAborted();

  return await buildGithubAppInstallUrl({
    appSlug,
    vm0UserId: args.userId,
    orgId: args.orgId,
    composeId: composeId ?? undefined,
    origin: args.origin,
    secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
  });
}

async function publishGithubChanged(userIds: readonly string[]): Promise<void> {
  const uniqueUserIds = Array.from(new Set(userIds));
  if (uniqueUserIds.length === 0) {
    return;
  }

  await publishUserSignal(uniqueUserIds, "github:changed");
}

type GitHubInstallationRecord = typeof githubInstallations.$inferSelect;

interface GitHubUserLinkRecord {
  readonly githubUserId: string;
}

function canManageInstallation(args: {
  readonly orgRole: string | undefined;
}): boolean {
  return args.orgRole === "admin";
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

async function loadUserGithubConnectorUsername(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<string | null> {
  const [connector] = await args.db
    .select({ externalUsername: connectors.externalUsername })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, "github"),
      ),
    )
    .limit(1);

  return connector?.externalUsername ?? null;
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

export const getGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const origin = getOAuthWebOrigin(get(request$).raw);
    const db = set(writeDb$);
    const installation = await loadOrgGithubInstallation(db, auth.orgId);
    signal.throwIfAborted();

    if (!installation) {
      const installUrl = canManageInstallation({ orgRole: auth.orgRole })
        ? await githubInstallUrl({
            db,
            userId: auth.userId,
            orgId: auth.orgId,
            origin,
            signal,
          })
        : null;
      signal.throwIfAborted();

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

    const connectedGithubUsername =
      link === null
        ? null
        : await loadUserGithubConnectorUsername({
            db,
            orgId: auth.orgId,
            userId: auth.userId,
          });
    signal.throwIfAborted();

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolver.resolveNewActionMethod({
      connectorSlug: "github",
      authMethodId: getGithubOAuthAuthMethod(),
      expectedGrantKind: "auth-code",
    });
    signal.throwIfAborted();
    const connectUrl =
      link === null && resolvedMethod.ok
        ? ((await buildGithubUserConnectAuthorizationUrl({
            db,
            vm0UserId: auth.userId,
            orgId: auth.orgId,
            origin,
            authMethodId: resolvedMethod.authMethodId,
            method: resolvedMethod.method,
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
        isAdmin: canManageInstallation({ orgRole: auth.orgRole }),
      },
      isConnected: link !== null,
      connectedGithubUserId: link?.githubUserId ?? null,
      connectedGithubUsername,
      connectUrl,
    };

    return { status: 200 as const, body };
  },
);
