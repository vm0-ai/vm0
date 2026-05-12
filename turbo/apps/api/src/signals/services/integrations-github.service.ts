import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { command } from "ccstate";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { eq } from "drizzle-orm";

import { authContext$ } from "../auth/auth-context";
import { writeDb$ } from "../external/db";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";

const INSTALLATION_ID_RE = /^\d+$/;
const L = logger("IntegrationsGithub");

function errorResponse(
  status: 401 | 403 | 404 | 500,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
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
