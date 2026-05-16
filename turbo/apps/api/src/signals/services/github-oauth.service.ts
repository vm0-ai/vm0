import { Buffer } from "node:buffer";
import { createSign, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";

import type { Db } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { now } from "../../lib/time";
import { logger } from "../../lib/log";
import { encryptSecretValue } from "./crypto.utils";

const L = logger("GithubOAuth");
const INSTALLATION_ID_RE = /^\d+$/;

interface AppInstallation {
  readonly id: number;
  readonly account: {
    readonly id: number;
    readonly login: string;
    readonly type: string;
  };
}

interface GitHubInstallationInfo {
  readonly targetType: string;
  readonly targetId: string;
  readonly targetName: string;
}

interface GithubOAuthState {
  readonly vm0UserId: string | null;
  readonly composeId: string | null;
  readonly sig: string | null;
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
  const body = match[2];
  const footer = match[3];
  if (!header || !body || !footer) {
    return input;
  }

  return `${header}\n${body.replace(/\s+/g, "\n")}\n${footer}\n`;
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

function githubHeaders(appId: string, privateKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function listGithubAppInstallations(args: {
  readonly appId: string;
  readonly privateKey: string;
  readonly signal: AbortSignal;
}): Promise<readonly AppInstallation[]> {
  const response = await fetch("https://api.github.com/app/installations", {
    headers: githubHeaders(args.appId, args.privateKey),
    signal: args.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to list app installations: ${response.status} ${body}`,
    );
  }

  return (await response.json()) as AppInstallation[];
}

export async function getGithubInstallationInfo(args: {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<GitHubInstallationInfo> {
  const installationId = validateInstallationId(args.installationId);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: githubHeaders(args.appId, args.privateKey),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to get installation info: ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as {
    readonly account: {
      readonly id: number;
      readonly login: string;
      readonly type: string;
    };
  };

  return {
    targetType: data.account.type,
    targetId: String(data.account.id),
    targetName: data.account.login,
  };
}

export async function getGithubInstallationAccessToken(args: {
  readonly appId: string;
  readonly privateKey: string;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly token: string; readonly expiresAt: string }> {
  const installationId = validateInstallationId(args.installationId);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(args.appId, args.privateKey),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to get installation access token: ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as {
    readonly token: string;
    readonly expires_at: string;
  };
  return { token: data.token, expiresAt: data.expires_at };
}

async function createGithubOauthStateSignature(args: {
  readonly vm0UserId: string;
  readonly composeId: string | null;
  readonly secretsEncryptionKey: string;
}): Promise<string> {
  const textEncoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(args.secretsEncryptionKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${args.vm0UserId}:${args.composeId ?? ""}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payload),
  );

  return Buffer.from(signature).toString("hex");
}

export async function buildGithubOauthState(args: {
  readonly vm0UserId?: string;
  readonly composeId?: string;
  readonly secretsEncryptionKey: string;
}): Promise<string> {
  const state: {
    vm0UserId?: string;
    composeId?: string;
    sig?: string;
  } = {};
  if (args.vm0UserId) {
    state.vm0UserId = args.vm0UserId;
  }
  if (args.composeId) {
    state.composeId = args.composeId;
  }
  if (state.vm0UserId) {
    state.sig = await createGithubOauthStateSignature({
      vm0UserId: state.vm0UserId,
      composeId: state.composeId ?? null,
      secretsEncryptionKey: args.secretsEncryptionKey,
    });
  }

  return Object.keys(state).length > 0 ? JSON.stringify(state) : "";
}

export function parseGithubOauthState(
  state: string | undefined,
): GithubOAuthState | null {
  if (!state) {
    return { vm0UserId: null, composeId: null, sig: null };
  }

  const parsed = safeJsonParse(state);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const stateObject = parsed as {
    readonly vm0UserId?: unknown;
    readonly composeId?: unknown;
    readonly sig?: unknown;
  };

  return {
    vm0UserId:
      typeof stateObject.vm0UserId === "string" ? stateObject.vm0UserId : null,
    composeId:
      typeof stateObject.composeId === "string" ? stateObject.composeId : null,
    sig: typeof stateObject.sig === "string" ? stateObject.sig : null,
  };
}

export async function isGithubOauthStateSignatureValid(args: {
  readonly state: GithubOAuthState;
  readonly secretsEncryptionKey: string;
}): Promise<boolean> {
  if (!args.state.vm0UserId) {
    return true;
  }

  const expectedSig = await createGithubOauthStateSignature({
    vm0UserId: args.state.vm0UserId,
    composeId: args.state.composeId,
    secretsEncryptionKey: args.secretsEncryptionKey,
  });

  return (
    args.state.sig !== null &&
    args.state.sig.length === expectedSig.length &&
    timingSafeEqual(Buffer.from(args.state.sig), Buffer.from(expectedSig))
  );
}

export async function linkGithubVm0User(args: {
  readonly db: Db;
  readonly installRecordId: string;
  readonly vm0UserId: string;
  readonly knownGithubUserId?: string | null;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  let githubUserId = args.knownGithubUserId ?? null;

  if (!githubUserId) {
    const [connector] = await args.db
      .select({ externalId: connectors.externalId })
      .from(connectors)
      .where(
        and(
          eq(connectors.userId, args.vm0UserId),
          eq(connectors.type, "github"),
        ),
      )
      .limit(1);
    args.signal.throwIfAborted();

    githubUserId = connector?.externalId ?? null;
  }

  if (!githubUserId) {
    return null;
  }

  await args.db
    .insert(githubUserLinks)
    .values({
      githubUserId,
      installationId: args.installRecordId,
      vm0UserId: args.vm0UserId,
    })
    .onConflictDoNothing();
  args.signal.throwIfAborted();

  return githubUserId;
}

export async function tryLinkGithubFromLocalRecord(args: {
  readonly db: Db;
  readonly vm0UserId: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [existing] = await args.db
    .select({
      id: githubInstallations.id,
      adminGithubUserId: githubInstallations.adminGithubUserId,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.status, "active"))
    .limit(1);
  args.signal.throwIfAborted();

  if (!existing) {
    return false;
  }

  const githubUserId = await linkGithubVm0User({
    db: args.db,
    installRecordId: existing.id,
    vm0UserId: args.vm0UserId,
    signal: args.signal,
  });

  if (!githubUserId) {
    return false;
  }

  if (!existing.adminGithubUserId) {
    await args.db
      .update(githubInstallations)
      .set({ adminGithubUserId: githubUserId })
      .where(eq(githubInstallations.id, existing.id));
    args.signal.throwIfAborted();
  }

  return true;
}

export async function tryLinkGithubFromRemoteInstallations(args: {
  readonly db: Db;
  readonly appId: string;
  readonly privateKey: string;
  readonly vm0UserId: string;
  readonly composeId: string | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const installationsResult = await settle(
    listGithubAppInstallations({
      appId: args.appId,
      privateKey: args.privateKey,
      signal: args.signal,
    }),
  );
  if (!installationsResult.ok) {
    L.warn("Failed to list app installations", {
      error: installationsResult.error,
    });
    return false;
  }
  const installations = installationsResult.value;
  args.signal.throwIfAborted();

  if (installations.length === 0) {
    return false;
  }

  for (const ghInstall of installations) {
    const ghInstallationId = String(ghInstall.id);
    const [existing] = await args.db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, ghInstallationId))
      .limit(1);
    args.signal.throwIfAborted();

    if (existing) {
      const linked = await linkGithubVm0User({
        db: args.db,
        installRecordId: existing.id,
        vm0UserId: args.vm0UserId,
        signal: args.signal,
      });
      return linked !== null;
    }
  }

  const ghInstall = installations[0];
  if (!ghInstall) {
    return false;
  }

  if (!args.composeId) {
    return false;
  }

  const ghInstallationId = String(ghInstall.id);
  const { token } = await getGithubInstallationAccessToken({
    appId: args.appId,
    privateKey: args.privateKey,
    installationId: ghInstallationId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const adminGithubUserId =
    ghInstall.account.type === "User" ? String(ghInstall.account.id) : null;

  const [newInstall] = await args.db
    .insert(githubInstallations)
    .values({
      installationId: ghInstallationId,
      encryptedAccessToken: encryptSecretValue(token),
      status: "active",
      targetType: ghInstall.account.type,
      targetId: String(ghInstall.account.id),
      targetName: ghInstall.account.login,
      adminGithubUserId,
      defaultComposeId: args.composeId,
    })
    .returning({ id: githubInstallations.id });
  args.signal.throwIfAborted();

  if (!newInstall) {
    L.error("Failed to create GitHub installation record", {
      ghInstallationId,
    });
    return false;
  }

  await linkGithubVm0User({
    db: args.db,
    installRecordId: newInstall.id,
    vm0UserId: args.vm0UserId,
    knownGithubUserId: adminGithubUserId,
    signal: args.signal,
  });

  return true;
}

export async function findGithubInstallationByInstallationId(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly id: string } | null> {
  const [existing] = await args.db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, args.installationId))
    .limit(1);
  args.signal.throwIfAborted();

  return existing ?? null;
}

export async function createPendingGithubInstallation(args: {
  readonly db: Db;
  readonly targetId: string | null;
  readonly targetType: string;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db.insert(githubInstallations).values({
    installationId: null,
    encryptedAccessToken: null,
    status: "pending",
    targetId: args.targetId,
    targetType: args.targetType,
    defaultComposeId: args.composeId,
  });
  args.signal.throwIfAborted();
}

export async function createOrActivateGithubInstallation(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly installInfo: GitHubInstallationInfo;
  readonly encryptedAccessToken: string;
  readonly adminGithubUserId: string | null;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [pendingRecord] = await args.db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.targetId, args.installInfo.targetId),
        eq(githubInstallations.status, "pending"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (pendingRecord) {
    await args.db
      .update(githubInstallations)
      .set({
        status: "active",
        installationId: args.installationId,
        encryptedAccessToken: args.encryptedAccessToken,
        targetType: args.installInfo.targetType,
        targetName: args.installInfo.targetName,
        adminGithubUserId: args.adminGithubUserId,
        updatedAt: new Date(now()),
      })
      .where(eq(githubInstallations.id, pendingRecord.id));
    args.signal.throwIfAborted();

    return pendingRecord.id;
  }

  const [newInstall] = await args.db
    .insert(githubInstallations)
    .values({
      installationId: args.installationId,
      encryptedAccessToken: args.encryptedAccessToken,
      status: "active",
      targetType: args.installInfo.targetType,
      targetId: args.installInfo.targetId,
      targetName: args.installInfo.targetName,
      adminGithubUserId: args.adminGithubUserId,
      defaultComposeId: args.composeId,
    })
    .returning({ id: githubInstallations.id });
  args.signal.throwIfAborted();

  if (!newInstall) {
    throw new Error("Expected GitHub installation insert to return a row");
  }

  return newInstall.id;
}
