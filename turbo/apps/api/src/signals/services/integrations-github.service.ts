import { command } from "ccstate";
import type {
  GithubConnectUserBody,
  GithubInstallationResponse,
} from "@vm0/api-contracts/contracts/integrations-github";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import { getOAuthWebOrigin } from "../routes/oauth-web-origin";
import {
  buildGithubUserConnectAuthorizationUrl,
  findGithubInstallationByInstallationId,
  linkGithubVm0User,
  verifyGithubConnectSignature,
} from "./github-oauth.service";

function errorResponse(status: 400 | 404 | 409, message: string, code: string) {
  return { status, body: { error: { message, code } } };
}

function githubConnectStartUrl(origin: string): string {
  return `${origin}/api/zero/github/oauth/connect`;
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
      return {
        status: 404 as const,
        body: {
          error: {
            message: "No GitHub installation found",
            code: "NOT_FOUND",
          },
        },
      };
    }

    const link = await loadUserGithubLink({
      db,
      installationId: installation.id,
      userId: auth.userId,
    });
    signal.throwIfAborted();

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
        isAdmin: canManageInstallation({ orgRole: auth.orgRole }),
      },
      isConnected: link !== null,
      connectedGithubUserId: link?.githubUserId ?? null,
      connectedGithubUsername: null,
      connectUrl,
    };

    return { status: 200 as const, body };
  },
);
