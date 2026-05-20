import { randomUUID } from "node:crypto";

import {
  cliAuthDeviceContract,
  cliAuthOrgContract,
  cliAuthTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth";
import {
  cliAuthTestApproveContract,
  cliAuthTestCodexOauthContract,
  cliAuthTestConnectorContract,
  cliAuthTestEnableConnectorContract,
  cliAuthTestTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth-test";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { connectors } from "@vm0/db/schema/connector";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { signPatJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { DEFAULT_TEST_EMAIL } from "../../services/cli-auth.service";
import { decryptSecretValue } from "../../services/crypto.utils";

const context = testContext();
const store = createStore();
const ORG_SENTINEL_USER_ID = "__org__";
const DEVICE_CODE_VALID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

interface DeviceAuthResponseBody {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_path: string;
  readonly expires_in: number;
  readonly interval: number;
}

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
}

interface ApiErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface CliTokenResponseBody {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
}

interface TestTokenResponseBody extends CliTokenResponseBody {
  readonly user_id: string;
}

interface TestApproveResponseBody {
  readonly success: true;
  readonly userId: string;
}

interface TestConnectorResponseBody {
  readonly ok: true;
  readonly connectorType: string;
  readonly orgId: string;
}

interface TestEnableConnectorResponseBody {
  readonly ok: true;
  readonly composeId: string;
  readonly connectorTypes: readonly string[];
}

interface TestCodexOauthResponseBody {
  readonly ok?: true;
  readonly orgId: string;
  readonly tokenExpiresAt?: string;
}

async function acceptResponse<TBody>(
  promise: Promise<HttpResponse>,
  expectedStatus: number,
): Promise<{ readonly status: number; readonly body: TBody }> {
  const response = await promise;
  expect(response.status).toBe(expectedStatus);
  return { status: response.status, body: response.body as TBody };
}

async function parseRawResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as unknown;
  }

  return await response.text();
}

async function postCliAuthOrgRaw(args: {
  readonly token?: string;
  readonly body: unknown;
}): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (args.token) {
    headers.authorization = `Bearer ${args.token}`;
  }

  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/cli/auth/org", {
    method: "POST",
    headers,
    body: JSON.stringify(args.body),
  });
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

async function postCliAuthTokenRaw(args: {
  readonly body: unknown;
}): Promise<HttpResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/cli/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args.body),
  });
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

async function postCliAuthTestApproveRaw(args: {
  readonly query?: string;
  readonly body: unknown;
}): Promise<HttpResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(
    `/api/cli/auth/test-approve${args.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args.body),
    },
  );
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

async function postCliAuthTestConnectorRaw(args: {
  readonly query?: string;
  readonly body: string;
}): Promise<HttpResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(
    `/api/cli/auth/test-connector${args.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: args.body,
    },
  );
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

async function postCliAuthTestEnableConnectorRaw(args: {
  readonly query?: string;
  readonly body: string;
}): Promise<HttpResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(
    `/api/cli/auth/test-enable-connector${args.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: args.body,
    },
  );
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

async function postCliAuthTestTokenRaw(args: {
  readonly query?: string;
  readonly headers?: Record<string, string>;
}): Promise<HttpResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(
    `/api/cli/auth/test-token${args.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...args.headers },
      body: JSON.stringify({}),
    },
  );
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

async function postCliAuthTestCodexOauthRaw(args: {
  readonly query?: string;
  readonly body: string;
}): Promise<HttpResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(
    `/api/cli/auth/test-codex-oauth${args.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: args.body,
    },
  );
  return {
    status: response.status,
    body: await parseRawResponseBody(response),
  };
}

describe("CLI auth routes", () => {
  const FAR_FUTURE_CACHE_AT = new Date("2126-01-01T00:00:00.000Z");

  const cleanupState = {
    deviceCodes: [] as string[],
    orgIds: [] as string[],
    userIds: [] as string[],
    composeIds: [] as string[],
  };

  function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
  }

  function trackOrg(orgId: string): string {
    cleanupState.orgIds.push(orgId);
    return orgId;
  }

  function trackUser(userId: string): string {
    cleanupState.userIds.push(userId);
    return userId;
  }

  function currentSecond(): number {
    return Math.floor(now() / 1000);
  }

  function randomDeviceCode(): string {
    const raw = randomUUID().replace(/-/g, "").toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  }

  function mockTestUser(args: {
    readonly userId: string;
    readonly orgId: string;
    readonly slug?: string;
    readonly email?: string;
  }): void {
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: args.userId }],
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
          organization: {
            id: args.orgId,
            slug: args.slug ?? "cli-auth-test-org",
            name: args.slug ?? "cli-auth-test-org",
          },
          publicUserData: { userId: args.userId },
          role: "org:admin",
        },
      ],
    });
  }

  async function seedOrgCache(args: {
    readonly orgId: string;
    readonly slug: string;
  }): Promise<void> {
    trackOrg(args.orgId);
    const writeDb = store.set(writeDb$);
    await writeDb
      .insert(orgCache)
      .values({
        orgId: args.orgId,
        slug: args.slug,
        name: args.slug,
        cachedAt: FAR_FUTURE_CACHE_AT,
      })
      .onConflictDoUpdate({
        target: orgCache.orgId,
        set: {
          slug: args.slug,
          name: args.slug,
          cachedAt: FAR_FUTURE_CACHE_AT,
        },
      });
  }

  async function seedOrgMembership(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly slug: string;
    readonly role?: "admin" | "member";
  }): Promise<void> {
    trackUser(args.userId);
    await seedOrgCache({ orgId: args.orgId, slug: args.slug });
    const writeDb = store.set(writeDb$);
    await writeDb
      .insert(orgMembersCache)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        role: args.role ?? "admin",
        cachedAt: FAR_FUTURE_CACHE_AT,
      })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: {
          role: args.role ?? "admin",
          cachedAt: FAR_FUTURE_CACHE_AT,
        },
      });
  }

  async function seedDeviceCode(args: {
    readonly status: "pending" | "authenticated" | "denied";
    readonly userId?: string;
    readonly orgId?: string;
    readonly expiresAt?: Date;
  }): Promise<string> {
    const code = randomDeviceCode();
    cleanupState.deviceCodes.push(code);
    const writeDb = store.set(writeDb$);
    const timestamp = nowDate();
    await writeDb.insert(deviceCodes).values({
      code,
      purpose: "cli",
      status: args.status,
      userId: args.userId,
      orgId: args.orgId,
      expiresAt:
        args.expiresAt ?? new Date(timestamp.getTime() + 15 * 60 * 1000),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return code;
  }

  async function seedCliToken(args: {
    readonly userId: string;
    readonly orgId: string;
  }): Promise<string> {
    const tokenId = randomUUID();
    const token = signPatJwtForTests({
      scope: "cli",
      userId: args.userId,
      orgId: args.orgId,
      tokenId,
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });
    const writeDb = store.set(writeDb$);
    await writeDb.insert(cliTokens).values({
      id: tokenId,
      token,
      userId: args.userId,
      name: "test token",
      expiresAt: new Date(now() + 60_000),
    });
    return token;
  }

  async function seedCompose(args: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<string> {
    const composeId = randomUUID();
    cleanupState.composeIds.push(composeId);
    const writeDb = store.set(writeDb$);
    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId: args.userId,
      orgId: args.orgId,
      name: `cli-auth-${composeId.slice(0, 8)}`,
    });
    return composeId;
  }

  async function fetchDeviceCode(code: string) {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.code, code))
      .limit(1);
    return row;
  }

  async function fetchCliToken(token: string) {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.token, token))
      .limit(1);
    return row;
  }

  async function findOrgModelProviderSecret(
    orgId: string,
    name: string,
  ): Promise<string | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, ORG_SENTINEL_USER_ID),
          eq(secrets.name, name),
          eq(secrets.type, "model-provider"),
        ),
      )
      .limit(1);

    return row ? decryptSecretValue(row.encryptedValue) : undefined;
  }

  async function findConnectorSecret(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name: string;
  }): Promise<string | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, args.name),
          eq(secrets.type, "connector"),
        ),
      )
      .limit(1);

    return row ? decryptSecretValue(row.encryptedValue) : undefined;
  }

  async function readConnectorState(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: string;
  }): Promise<{
    readonly authMethod: string;
    readonly externalId: string | null;
    readonly externalUsername: string | null;
    readonly externalEmail: string | null;
    readonly oauthScopes: string | null;
    readonly tokenExpiresAt: Date | null;
    readonly needsReconnect: boolean;
  } | null> {
    const writeDb = store.set(writeDb$);
    const [connector] = await writeDb
      .select({
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        tokenExpiresAt: connectors.tokenExpiresAt,
        needsReconnect: connectors.needsReconnect,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, args.type),
        ),
      )
      .limit(1);

    return connector ?? null;
  }

  async function readOrgCodexOauthProviderState(orgId: string): Promise<{
    readonly authMethod: string | null;
    readonly tokenExpiresAt: Date | null;
    readonly workspaceName: string | null;
    readonly planType: string | null;
    readonly needsReconnect: boolean;
    readonly lastRefreshErrorCode: string | null;
  } | null> {
    const writeDb = store.set(writeDb$);
    const [provider] = await writeDb
      .select({
        authMethod: modelProviders.authMethod,
        tokenExpiresAt: modelProviders.tokenExpiresAt,
        workspaceName: modelProviders.workspaceName,
        planType: modelProviders.planType,
        needsReconnect: modelProviders.needsReconnect,
        lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
      })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          eq(modelProviders.type, "codex-oauth-token"),
        ),
      )
      .limit(1);

    return provider ?? null;
  }

  function base64UrlEncode(input: string): string {
    return Buffer.from(input, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function makeJwt(payload: Record<string, unknown>): string {
    const header = base64UrlEncode(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    );
    const body = base64UrlEncode(JSON.stringify(payload));
    return `${header}.${body}.fake-signature`;
  }

  function makeCodexIdToken(args: {
    readonly accountId: string;
    readonly planType: string;
    readonly workspaceName?: string;
  }): string {
    const authClaims: Record<string, unknown> = {
      chatgpt_account_id: args.accountId,
      chatgpt_plan_type: args.planType,
    };
    if (args.workspaceName !== undefined) {
      authClaims.organization = { title: args.workspaceName };
    }

    return makeJwt({
      "https://api.openai.com/auth": authClaims,
      exp: Math.floor(now() / 1000) + 3600,
    });
  }

  function makeCodexAuthJson(args?: {
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly accountId?: string;
    readonly idTokenAccountId?: string;
    readonly planType?: string;
    readonly workspaceName?: string;
  }): string {
    const accessExp = Math.floor(now() / 1000) + 7200;
    return JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: args?.accessToken ?? makeJwt({ exp: accessExp }),
        refresh_token:
          args?.refreshToken ?? "rt_synthetic_authjson_seed_high_entropy",
        account_id: args?.accountId ?? "ws_acct_plain",
        id_token: makeCodexIdToken({
          accountId: args?.idTokenAccountId ?? "ws_acct_id_token",
          planType: args?.planType ?? "plus",
          workspaceName: args?.workspaceName ?? "Acme",
        }),
      },
    });
  }

  beforeEach(() => {
    mockEnv("ENV", "development");
    mockOptionalEnv("USE_MOCK_CLAUDE", undefined);
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", undefined);
  });

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    const orgIds = unique(cleanupState.orgIds);
    const userIds = unique(cleanupState.userIds);
    const composeIds = unique(cleanupState.composeIds);
    const codes = unique(cleanupState.deviceCodes);

    if (orgIds.length > 0) {
      await writeDb
        .delete(userConnectors)
        .where(inArray(userConnectors.orgId, orgIds));
      await writeDb.delete(connectors).where(inArray(connectors.orgId, orgIds));
      await writeDb
        .delete(modelProviders)
        .where(inArray(modelProviders.orgId, orgIds));
      await writeDb.delete(secrets).where(inArray(secrets.orgId, orgIds));
      await writeDb
        .delete(creditExpiresRecord)
        .where(inArray(creditExpiresRecord.orgId, orgIds));
      await writeDb
        .delete(orgMetadata)
        .where(inArray(orgMetadata.orgId, orgIds));
      await writeDb
        .delete(orgMembersCache)
        .where(inArray(orgMembersCache.orgId, orgIds));
      await writeDb.delete(orgCache).where(inArray(orgCache.orgId, orgIds));
    }

    if (composeIds.length > 0) {
      await writeDb
        .delete(zeroAgents)
        .where(inArray(zeroAgents.id, composeIds));
      await writeDb
        .delete(agentComposes)
        .where(inArray(agentComposes.id, composeIds));
    }

    if (codes.length > 0) {
      await writeDb.delete(deviceCodes).where(inArray(deviceCodes.code, codes));
    }

    if (userIds.length > 0) {
      await writeDb.delete(cliTokens).where(inArray(cliTokens.userId, userIds));
    }

    cleanupState.deviceCodes.length = 0;
    cleanupState.orgIds.length = 0;
    cleanupState.userIds.length = 0;
    cleanupState.composeIds.length = 0;
  });

  describe("POST /api/cli/auth/device", () => {
    it("creates a pending CLI device code", async () => {
      const client = setupApp({ context })(cliAuthDeviceContract);

      const response = await acceptResponse<DeviceAuthResponseBody>(
        client.create({ body: {} }),
        200,
      );
      cleanupState.deviceCodes.push(response.body.device_code);

      expect(response.body.device_code).toMatch(
        new RegExp(
          `^[${DEVICE_CODE_VALID_CHARS}]{4}-[${DEVICE_CODE_VALID_CHARS}]{4}$`,
        ),
      );
      expect(response.body.user_code).toBe(response.body.device_code);
      expect(response.body.verification_path).toBe("/cli-auth");
      expect(response.body.expires_in).toBe(900);
      expect(response.body.interval).toBe(5);

      const row = await fetchDeviceCode(response.body.device_code);
      expect(row).toMatchObject({ purpose: "cli", status: "pending" });
    });

    it("generates unique CLI device codes on repeated calls", async () => {
      const client = setupApp({ context })(cliAuthDeviceContract);

      const first = await acceptResponse<DeviceAuthResponseBody>(
        client.create({ body: {} }),
        200,
      );
      const second = await acceptResponse<DeviceAuthResponseBody>(
        client.create({ body: {} }),
        200,
      );
      cleanupState.deviceCodes.push(
        first.body.device_code,
        second.body.device_code,
      );

      expect(first.body.device_code).not.toBe(second.body.device_code);
    });
  });

  describe("POST /api/cli/auth/token", () => {
    it("returns invalid_request for unknown CLI device codes", async () => {
      const client = setupApp({ context })(cliAuthTokenContract);

      const response = await acceptResponse<OAuthErrorBody>(
        client.exchange({ body: { device_code: "ZZZZ-ZZZZ" } }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "invalid_request",
        error_description: "Invalid device code",
      });
    });

    it("returns expired_token for expired CLI device codes", async () => {
      const code = await seedDeviceCode({
        status: "pending",
        expiresAt: new Date(nowDate().getTime() - 1000),
      });
      const client = setupApp({ context })(cliAuthTokenContract);

      const response = await acceptResponse<OAuthErrorBody>(
        client.exchange({ body: { device_code: code } }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "expired_token",
        error_description: "The device code has expired",
      });
    });

    it("returns authorization_pending for pending CLI device codes", async () => {
      const code = await seedDeviceCode({ status: "pending" });
      const client = setupApp({ context })(cliAuthTokenContract);

      const response = await acceptResponse<OAuthErrorBody>(
        client.exchange({ body: { device_code: code } }),
        202,
      );

      expect(response.body).toStrictEqual({
        error: "authorization_pending",
        error_description:
          "The user has not yet completed authorization in the browser",
      });
    });

    it("returns access_denied and deletes denied CLI device codes", async () => {
      const code = await seedDeviceCode({ status: "denied" });
      const client = setupApp({ context })(cliAuthTokenContract);

      const response = await acceptResponse<OAuthErrorBody>(
        client.exchange({ body: { device_code: code } }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "access_denied",
        error_description: "The user denied the authorization request",
      });
      await expect(fetchDeviceCode(code)).resolves.toBeUndefined();
    });

    it("issues a PAT and deletes the device code after authentication", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      const code = await seedDeviceCode({
        status: "authenticated",
        userId,
        orgId,
      });
      const client = setupApp({ context })(cliAuthTokenContract);

      const response = await acceptResponse<CliTokenResponseBody>(
        client.exchange({ body: { device_code: code } }),
        200,
      );

      expect(response.body.access_token).toMatch(/^vm0_pat_/);
      expect(response.body.token_type).toBe("Bearer");
      expect(response.body.expires_in).toBe(90 * 24 * 60 * 60);
      expect(response.body).not.toHaveProperty("org_slug");
      await expect(fetchDeviceCode(code)).resolves.toBeUndefined();
      await expect(
        fetchCliToken(response.body.access_token),
      ).resolves.toMatchObject({
        userId,
        name: "CLI Device Flow Authentication",
      });
    });

    it("returns invalid_request when device_code is missing from the body", async () => {
      const response = await acceptResponse<OAuthErrorBody>(
        postCliAuthTokenRaw({ body: {} }),
        400,
      );

      expect(response.body.error).toBe("invalid_request");
      expect(response.body.error_description).toContain("device_code");
    });
  });

  describe("POST /api/cli/auth/org", () => {
    it("switches a PAT to a target organization by slug", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const sourceOrgId = trackOrg(`org_${randomUUID()}`);
      const targetOrgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId: sourceOrgId,
        userId,
        slug: `source-${randomUUID()}`,
      });
      const targetSlug = `target-${randomUUID()}`;
      await seedOrgMembership({
        orgId: targetOrgId,
        userId,
        slug: targetSlug,
        role: "member",
      });
      const token = await seedCliToken({ userId, orgId: sourceOrgId });
      const client = setupApp({ context })(cliAuthOrgContract);

      const response = await acceptResponse<CliTokenResponseBody>(
        client.switchOrg({
          headers: { authorization: `Bearer ${token}` },
          body: { slug: targetSlug },
        }),
        200,
      );

      expect(response.body.access_token).toMatch(/^vm0_pat_/);
      expect(response.body.token_type).toBe("Bearer");
      expect(response.body.expires_in).toBe(90 * 24 * 60 * 60);
      await expect(
        fetchCliToken(response.body.access_token),
      ).resolves.toMatchObject({
        userId,
        name: "CLI Org Switch",
      });
    });

    it("refreshes org cache from Clerk when switching to an uncached slug", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const sourceOrgId = trackOrg(`org_${randomUUID()}`);
      const targetOrgId = trackOrg(`org_${randomUUID()}`);
      const targetSlug = `target-${randomUUID()}`;
      context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
        id: targetOrgId,
        slug: targetSlug,
        name: "Target Org",
        createdBy: userId,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
              organization: {
                id: sourceOrgId,
                slug: `source-${randomUUID()}`,
                name: "Source Org",
              },
              publicUserData: { userId },
              role: "org:admin",
            },
            {
              createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
              organization: {
                id: targetOrgId,
                slug: targetSlug,
                name: "Target Org",
              },
              publicUserData: { userId },
              role: "org:member",
            },
          ],
        },
      );
      const token = await seedCliToken({ userId, orgId: sourceOrgId });
      const client = setupApp({ context })(cliAuthOrgContract);

      const response = await acceptResponse<CliTokenResponseBody>(
        client.switchOrg({
          headers: { authorization: `Bearer ${token}` },
          body: { slug: targetSlug },
        }),
        200,
      );

      expect(response.body.access_token).toMatch(/^vm0_pat_/);
      await expect(
        fetchCliToken(response.body.access_token),
      ).resolves.toMatchObject({
        userId,
        name: "CLI Org Switch",
      });

      const writeDb = store.set(writeDb$);
      await expect(
        writeDb
          .select()
          .from(orgCache)
          .where(eq(orgCache.orgId, targetOrgId))
          .limit(1),
      ).resolves.toMatchObject([
        expect.objectContaining({ slug: targetSlug, name: "Target Org" }),
      ]);
    });

    it("returns 401 when no auth is provided", async () => {
      const response = await acceptResponse<ApiErrorBody>(
        postCliAuthOrgRaw({ body: { slug: "some-org" } }),
        401,
      );

      expect(response.body).toStrictEqual({
        error: { message: "Authentication required", code: "unauthorized" },
      });
    });

    it("returns 404 when the org slug does not exist", async () => {
      const userId = `user_${randomUUID()}`;
      const sourceOrgId = `org_${randomUUID()}`;
      await seedOrgMembership({
        orgId: sourceOrgId,
        userId,
        slug: `source-${randomUUID()}`,
      });
      context.mocks.clerk.organizations.getOrganization.mockRejectedValue({
        statusCode: 404,
      });
      const token = await seedCliToken({ userId, orgId: sourceOrgId });
      const client = setupApp({ context })(cliAuthOrgContract);

      const response = await acceptResponse<ApiErrorBody>(
        client.switchOrg({
          headers: { authorization: `Bearer ${token}` },
          body: { slug: `missing-${randomUUID()}` },
        }),
        404,
      );

      expect(response.body.error.code).toBe("not_found");
    });

    it("returns 403 when the user is not a member of the target org", async () => {
      const userId = `user_${randomUUID()}`;
      const sourceOrgId = `org_${randomUUID()}`;
      await seedOrgMembership({
        orgId: sourceOrgId,
        userId,
        slug: `source-${randomUUID()}`,
      });
      const targetOrgId = `org_${randomUUID()}`;
      const targetSlug = `target-${randomUUID()}`;
      await seedOrgCache({ orgId: targetOrgId, slug: targetSlug });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [],
        },
      );
      const token = await seedCliToken({ userId, orgId: sourceOrgId });
      const client = setupApp({ context })(cliAuthOrgContract);

      const response = await acceptResponse<ApiErrorBody>(
        client.switchOrg({
          headers: { authorization: `Bearer ${token}` },
          body: { slug: targetSlug },
        }),
        403,
      );

      expect(response.body.error.code).toBe("forbidden");
    });

    it("returns 400 when the slug is missing", async () => {
      const userId = `user_${randomUUID()}`;
      const sourceOrgId = `org_${randomUUID()}`;
      await seedOrgMembership({
        orgId: sourceOrgId,
        userId,
        slug: `source-${randomUUID()}`,
      });
      const token = await seedCliToken({ userId, orgId: sourceOrgId });

      const response = await acceptResponse<OAuthErrorBody>(
        postCliAuthOrgRaw({ token, body: {} }),
        400,
      );

      expect(response.body.error).toBe("invalid_request");
    });

    it("returns 400 when the slug is empty", async () => {
      const userId = `user_${randomUUID()}`;
      const sourceOrgId = `org_${randomUUID()}`;
      await seedOrgMembership({
        orgId: sourceOrgId,
        userId,
        slug: `source-${randomUUID()}`,
      });
      const token = await seedCliToken({ userId, orgId: sourceOrgId });
      const client = setupApp({ context })(cliAuthOrgContract);

      const response = await acceptResponse<OAuthErrorBody>(
        client.switchOrg({
          headers: { authorization: `Bearer ${token}` },
          body: { slug: "" },
        }),
        400,
      );

      expect(response.body.error).toBe("invalid_request");
    });
  });

  describe("POST /api/cli/auth/test-token", () => {
    it("returns 404 outside allowed test environments", async () => {
      mockEnv("ENV", "production");
      const client = setupApp({ context })(cliAuthTestTokenContract);

      const response = await acceptResponse<string>(
        client.create({ query: {}, body: {} }),
        404,
      );

      expect(response.body).toBe("Not found");
    });

    it("rejects direct preview requests without the Vercel bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

      const missingHeader = await acceptResponse<string>(
        postCliAuthTestTokenRaw({}),
        404,
      );
      expect(missingHeader.body).toBe("Not found");

      const invalidHeader = await acceptResponse<string>(
        postCliAuthTestTokenRaw({
          headers: { "x-vercel-protection-bypass": "wrong-secret" },
        }),
        404,
      );
      expect(invalidHeader.body).toBe("Not found");
    });

    it("allows direct preview requests with the Vercel bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId, slug: "test-token-preview-header" });

      const response = await acceptResponse<TestTokenResponseBody>(
        postCliAuthTestTokenRaw({
          headers: { "x-vercel-protection-bypass": "preview-secret" },
        }),
        200,
      );

      expect(response.body.user_id).toBe(userId);
      expect(response.body.access_token).toMatch(/^vm0_pat_/);
    });

    it("allows protected preview rewrites after Vercel consumes the bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId, slug: "test-token-preview-rewrite" });
      const client = setupApp({ context })(cliAuthTestTokenContract);

      const response = await acceptResponse<TestTokenResponseBody>(
        client.create({ query: {}, body: {} }),
        200,
      );

      expect(response.body.user_id).toBe(userId);
      expect(response.body.access_token).toMatch(/^vm0_pat_/);
    });

    it("creates a test PAT and seeds org lookup state in development", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId, slug: "test-token-org" });
      const client = setupApp({ context })(cliAuthTestTokenContract);

      const response = await acceptResponse<TestTokenResponseBody>(
        client.create({ query: {}, body: {} }),
        200,
      );

      expect(response.body).toMatchObject({
        token_type: "Bearer",
        expires_in: 90 * 24 * 60 * 60,
        user_id: userId,
      });
      expect(response.body.access_token).toMatch(/^vm0_pat_/);
      expect(response.body).not.toHaveProperty("org_slug");
      await expect(
        fetchCliToken(response.body.access_token),
      ).resolves.toMatchObject({
        userId,
        name: "CI Test Token",
      });

      const writeDb = store.set(writeDb$);
      await expect(
        writeDb
          .select()
          .from(orgCache)
          .where(eq(orgCache.orgId, orgId))
          .limit(1),
      ).resolves.toHaveLength(1);
      await expect(
        writeDb
          .select()
          .from(orgMembersCache)
          .where(
            and(
              eq(orgMembersCache.orgId, orgId),
              eq(orgMembersCache.userId, userId),
            ),
          )
          .limit(1),
      ).resolves.toHaveLength(1);
      await expect(
        writeDb
          .select()
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, orgId))
          .limit(1),
      ).resolves.toHaveLength(1);
    });

    it("returns 500 when the test user cannot be resolved", async () => {
      context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });

      const response = await postCliAuthTestTokenRaw({});

      expect(response.status).toBe(500);
    });

    it("resolves the default test user email through Clerk", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId, slug: "test-token-default-email" });
      const client = setupApp({ context })(cliAuthTestTokenContract);

      await acceptResponse<TestTokenResponseBody>(
        client.create({ query: {}, body: {} }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: [DEFAULT_TEST_EMAIL],
      });
    });

    it("resolves a custom test user email through Clerk", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId, slug: "test-token-custom-email" });
      const client = setupApp({ context })(cliAuthTestTokenContract);

      await acceptResponse<TestTokenResponseBody>(
        client.create({ query: { email: "custom@test.com" }, body: {} }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: ["custom@test.com"],
      });
    });
  });

  describe("POST /api/cli/auth/test-approve", () => {
    it("returns not found when mock Claude is not enabled", async () => {
      const client = setupApp({ context })(cliAuthTestApproveContract);

      const unsetResponse = await acceptResponse<string>(
        client.approve({
          query: {},
          body: { device_code: "TEST-CODE" },
        }),
        404,
      );
      expect(unsetResponse.body).toBe("Not found");

      mockOptionalEnv("USE_MOCK_CLAUDE", "false");
      const falseResponse = await acceptResponse<string>(
        client.approve({
          query: {},
          body: { device_code: "TEST-CODE" },
        }),
        404,
      );
      expect(falseResponse.body).toBe("Not found");
    });

    it("returns validation errors for missing and unknown device codes", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const client = setupApp({ context })(cliAuthTestApproveContract);

      const missingResponse = await acceptResponse<{ readonly error: string }>(
        client.approve({ query: {}, body: {} }),
        400,
      );
      expect(missingResponse.body).toStrictEqual({
        error: "device_code required",
      });

      const unknownResponse = await acceptResponse<string>(
        client.approve({
          query: {},
          body: { device_code: "XXXX-XXXX" },
        }),
        404,
      );
      expect(unknownResponse.body).toBe("Not found");
    });

    it("rejects device codes that are no longer pending", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const code = await seedDeviceCode({ status: "denied" });
      const client = setupApp({ context })(cliAuthTestApproveContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.approve({ query: {}, body: { device_code: code } }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Device code is not in pending status",
      });
    });

    it("rejects expired device codes", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const code = await seedDeviceCode({
        status: "pending",
        expiresAt: new Date(nowDate().getTime() - 1000),
      });
      const client = setupApp({ context })(cliAuthTestApproveContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.approve({ query: {}, body: { device_code: code } }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Device code has expired",
      });
    });

    it("approves a pending CLI device code when mock Claude is enabled", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId });
      const deviceClient = setupApp({ context })(cliAuthDeviceContract);
      const approveClient = setupApp({ context })(cliAuthTestApproveContract);
      const deviceResponse = await acceptResponse<DeviceAuthResponseBody>(
        deviceClient.create({ body: {} }),
        200,
      );
      cleanupState.deviceCodes.push(deviceResponse.body.device_code);

      const response = await acceptResponse<TestApproveResponseBody>(
        approveClient.approve({
          query: { email: DEFAULT_TEST_EMAIL },
          body: { device_code: deviceResponse.body.device_code },
        }),
        200,
      );

      expect(response.body).toStrictEqual({ success: true, userId });
      await expect(
        fetchDeviceCode(deviceResponse.body.device_code),
      ).resolves.toMatchObject({
        status: "authenticated",
        userId,
      });
    });

    it("handles case-insensitive device codes", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId });
      const code = await seedDeviceCode({ status: "pending" });
      const client = setupApp({ context })(cliAuthTestApproveContract);

      const response = await acceptResponse<TestApproveResponseBody>(
        client.approve({
          query: {},
          body: { device_code: code.toLowerCase() },
        }),
        200,
      );

      expect(response.body).toStrictEqual({ success: true, userId });
      await expect(fetchDeviceCode(code)).resolves.toMatchObject({
        status: "authenticated",
        userId,
      });
    });

    it("returns an internal error when the test user cannot be resolved", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
      const code = await seedDeviceCode({ status: "pending" });

      const response = await postCliAuthTestApproveRaw({
        body: { device_code: code },
      });

      expect(response.status).toBe(500);
      expect(response.body).toStrictEqual({ error: "Internal server error" });
      await expect(fetchDeviceCode(code)).resolves.toMatchObject({
        status: "pending",
        userId: null,
      });
    });

    it("resolves the default test user email through Clerk", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId });
      const code = await seedDeviceCode({ status: "pending" });
      const client = setupApp({ context })(cliAuthTestApproveContract);

      await acceptResponse<TestApproveResponseBody>(
        client.approve({ query: {}, body: { device_code: code } }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: [DEFAULT_TEST_EMAIL],
      });
    });

    it("resolves a custom test user email through Clerk", async () => {
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId });
      const code = await seedDeviceCode({ status: "pending" });
      const client = setupApp({ context })(cliAuthTestApproveContract);

      await acceptResponse<TestApproveResponseBody>(
        client.approve({
          query: { email: "custom@test.com" },
          body: { device_code: code },
        }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: ["custom@test.com"],
      });
    });
  });

  describe("POST /api/cli/auth/test-connector", () => {
    it("returns 404 outside allowed test environments", async () => {
      mockEnv("ENV", "production");
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const response = await acceptResponse<string>(
        client.create({
          query: {},
          body: {
            connectorName: "github",
            accessToken: "github-access-token",
          },
        }),
        404,
      );

      expect(response.body).toBe("Not found");
    });

    it("rejects invalid JSON bodies with the legacy error", async () => {
      const response = await acceptResponse<{ readonly error: string }>(
        postCliAuthTestConnectorRaw({ body: "{ not json" }),
        400,
      );

      expect(response.body).toStrictEqual({ error: "Invalid JSON body" });
    });

    it("rejects invalid body shapes with the legacy error", async () => {
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const missingFields = await acceptResponse<{ readonly error: string }>(
        postCliAuthTestConnectorRaw({
          body: JSON.stringify({ connectorName: "github" }),
        }),
        400,
      );
      expect(missingFields.body).toStrictEqual({
        error: "connectorName and accessToken are required",
      });

      const emptyRefreshToken = await acceptResponse<{
        readonly error: string;
      }>(
        client.create({
          query: {},
          body: {
            connectorName: "github",
            accessToken: "github-access-token",
            refreshToken: "",
          },
        }),
        400,
      );
      expect(emptyRefreshToken.body).toStrictEqual({
        error: "connectorName and accessToken are required",
      });
    });

    it("rejects unknown connector types", async () => {
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: {
            connectorName: "unknown-connector",
            accessToken: "unknown-access-token",
          },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: 'Unknown connector type: "unknown-connector"',
      });
    });

    it("requires the test user to have cached org membership", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = `org_${randomUUID()}`;
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: {
            connectorName: "github",
            accessToken: "github-access-token",
          },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Test user has no org — run test-token first",
      });
    });

    it("rejects connector types that do not use OAuth", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "connector-non-oauth" });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: {
            connectorName: "computer",
            accessToken: "computer-access-token",
          },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "computer connector does not use OAuth",
      });
      await expect(
        readConnectorState({ orgId, userId, type: "computer" }),
      ).resolves.toBeNull();
      await expect(
        findConnectorSecret({
          orgId,
          userId,
          name: "COMPUTER_CONNECTOR_AUTHTOKEN",
        }),
      ).resolves.toBeUndefined();
    });

    it("seeds OAuth connector token state for the test user org", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "connector-org" });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const response = await acceptResponse<TestConnectorResponseBody>(
        client.create({
          query: {},
          body: {
            connectorName: "test-oauth",
            accessToken: "test-oauth-access-token",
            refreshToken: "test-oauth-refresh-token",
            expiresIn: -60,
          },
        }),
        200,
      );

      expect(response.body).toStrictEqual({
        ok: true,
        connectorType: "test-oauth",
        orgId,
      });

      await expect(
        readConnectorState({ orgId, userId, type: "test-oauth" }),
      ).resolves.toMatchObject({
        authMethod: "oauth",
        externalId: "e2e-test-test-oauth",
        externalUsername: "e2e-test-oauth",
        externalEmail: "e2e-test-oauth@test.vm0.ai",
        oauthScopes: "[]",
        needsReconnect: false,
      });
      const oauthConnector = await readConnectorState({
        orgId,
        userId,
        type: "test-oauth",
      });
      expect(oauthConnector?.tokenExpiresAt).toBeInstanceOf(Date);
      expect(oauthConnector!.tokenExpiresAt!.getTime()).toBeLessThan(now());
      await expect(
        findConnectorSecret({
          orgId,
          userId,
          name: "TEST_OAUTH_ACCESS_TOKEN",
        }),
      ).resolves.toBe("test-oauth-access-token");
      await expect(
        findConnectorSecret({
          orgId,
          userId,
          name: "TEST_OAUTH_REFRESH_TOKEN",
        }),
      ).resolves.toBe("test-oauth-refresh-token");
    });

    it("resolves a custom test user email through Clerk", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "connector-custom-email",
      });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      await acceptResponse<TestConnectorResponseBody>(
        client.create({
          query: { email: "custom@test.com" },
          body: {
            connectorName: "github",
            accessToken: "github-access-token",
          },
        }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: ["custom@test.com"],
      });
    });
  });

  describe("POST /api/cli/auth/test-enable-connector", () => {
    it("returns 404 outside allowed test environments", async () => {
      mockEnv("ENV", "production");
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);

      const response = await acceptResponse<string>(
        client.create({
          query: {},
          body: {
            composeId: "00000000-0000-0000-0000-000000000000",
            connectorTypes: ["github"],
          },
        }),
        404,
      );

      expect(response.body).toBe("Not found");
    });

    it("allows protected preview rewrites after Vercel consumes the bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "enable-connector-preview",
      });
      mockTestUser({ userId, orgId });
      const composeId = await seedCompose({ orgId, userId });
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);

      const response = await acceptResponse<TestEnableConnectorResponseBody>(
        client.create({
          query: {},
          body: { composeId, connectorTypes: ["github"] },
        }),
        200,
      );

      expect(response.body).toStrictEqual({
        ok: true,
        composeId,
        connectorTypes: ["github"],
      });
    });

    it("rejects invalid JSON with the legacy error", async () => {
      const response = await acceptResponse<{ readonly error: string }>(
        postCliAuthTestEnableConnectorRaw({ body: "{ not json" }),
        400,
      );

      expect(response.body).toStrictEqual({ error: "Invalid JSON body" });
    });

    it("rejects invalid bodies with the legacy validation error", async () => {
      const missingFields = await acceptResponse<{ readonly error: string }>(
        postCliAuthTestEnableConnectorRaw({ body: JSON.stringify({}) }),
        400,
      );
      expect(missingFields.body).toStrictEqual({
        error: "composeId and connectorTypes are required",
      });

      const invalidComposeId = await acceptResponse<{
        readonly error: string;
      }>(
        postCliAuthTestEnableConnectorRaw({
          body: JSON.stringify({
            composeId: "not-a-uuid",
            connectorTypes: ["github"],
          }),
        }),
        400,
      );
      expect(invalidComposeId.body).toStrictEqual({
        error: "composeId and connectorTypes are required",
      });

      const emptyConnectorTypes = await acceptResponse<{
        readonly error: string;
      }>(
        postCliAuthTestEnableConnectorRaw({
          body: JSON.stringify({
            composeId: "00000000-0000-0000-0000-000000000000",
            connectorTypes: [],
          }),
        }),
        400,
      );
      expect(emptyConnectorTypes.body).toStrictEqual({
        error: "composeId and connectorTypes are required",
      });
    });

    it("rejects unknown connector types", async () => {
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: {
            composeId: "00000000-0000-0000-0000-000000000000",
            connectorTypes: ["not-a-real-connector"],
          },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Unknown connector types: not-a-real-connector",
      });
    });

    it("rejects users without a cached test org", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: {
            composeId: "00000000-0000-0000-0000-000000000000",
            connectorTypes: ["github"],
          },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Test user has no org — run test-token first",
      });
    });

    it("rejects requests for a compose that does not exist", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "enable-missing-compose",
      });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);
      const composeId = "00000000-0000-0000-0000-000000000000";

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: { composeId, connectorTypes: ["github"] },
        }),
        404,
      );

      expect(response.body).toStrictEqual({
        error: `Compose not found: ${composeId}`,
      });
    });

    it("creates a zero agent row and enables requested connectors", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "enable-connector-org" });
      mockTestUser({ userId, orgId });
      const composeId = await seedCompose({ orgId, userId });
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);

      const response = await acceptResponse<TestEnableConnectorResponseBody>(
        client.create({
          query: {},
          body: { composeId, connectorTypes: ["github", "slack"] },
        }),
        200,
      );

      expect(response.body).toStrictEqual({
        ok: true,
        composeId,
        connectorTypes: ["github", "slack"],
      });

      const writeDb = store.set(writeDb$);
      const connectorRows = await writeDb
        .select({ connectorType: userConnectors.connectorType })
        .from(userConnectors)
        .where(
          and(
            eq(userConnectors.orgId, orgId),
            eq(userConnectors.userId, userId),
            eq(userConnectors.agentId, composeId),
          ),
        );
      expect(
        connectorRows
          .map((row) => {
            return row.connectorType;
          })
          .sort(),
      ).toStrictEqual(["github", "slack"]);
      await expect(
        writeDb
          .select()
          .from(zeroAgents)
          .where(eq(zeroAgents.id, composeId))
          .limit(1),
      ).resolves.toHaveLength(1);
    });

    it("resolves a custom test user email through Clerk", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "enable-connector-custom-email",
      });
      mockTestUser({ userId, orgId });
      const composeId = await seedCompose({ orgId, userId });
      const client = setupApp({ context })(cliAuthTestEnableConnectorContract);

      await acceptResponse<TestEnableConnectorResponseBody>(
        client.create({
          query: { email: "custom@test.com" },
          body: { composeId, connectorTypes: ["github"] },
        }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: ["custom@test.com"],
      });
    });
  });

  describe("POST /api/cli/auth/test-codex-oauth", () => {
    const LEGACY_CODEX_OAUTH_BODY = {
      accessToken: "REAL-AT-7f3a82d1-9b4c-4e5f-a1b2-c3d4e5f60718",
      refreshToken: "REAL-RT-1a2b3c4d-5e6f-7g8h-9i0j-k1l2m3n4o5p6",
      accountId: "ws_REAL_ACCOUNT_test",
      idToken: "hdr.PAYLOAD.SIG",
    } as const;

    it("returns 404 outside allowed test environments", async () => {
      mockEnv("ENV", "production");
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<string>(
        client.create({ query: {}, body: LEGACY_CODEX_OAUTH_BODY }),
        404,
      );

      expect(response.body).toBe("Not found");
    });

    it("allows protected preview rewrites after Vercel consumes the bypass header", async () => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("USE_MOCK_CLAUDE", "true");
      mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "codex-oauth-preview-rewrite",
      });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<TestCodexOauthResponseBody>(
        client.create({
          query: {},
          body: LEGACY_CODEX_OAUTH_BODY,
        }),
        200,
      );

      expect(response.body.orgId).toBe(orgId);
    });

    it("rejects invalid JSON bodies with the legacy error", async () => {
      const response = await acceptResponse<{ readonly error: string }>(
        postCliAuthTestCodexOauthRaw({ body: "{ not json" }),
        400,
      );

      expect(response.body).toStrictEqual({ error: "Invalid JSON body" });
    });

    it("rejects invalid body shapes", async () => {
      const response = await acceptResponse<{ readonly error: string }>(
        postCliAuthTestCodexOauthRaw({
          body: JSON.stringify({ accessToken: "missing-others" }),
        }),
        400,
      );

      expect(response.body.error).toBe("Invalid body shape");
    });

    it("requires the test user to have cached org membership", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = `org_${randomUUID()}`;
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({ query: {}, body: LEGACY_CODEX_OAUTH_BODY }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Test user has no org — run test-token first",
      });
    });

    it("seeds legacy Codex OAuth token state for the test user org", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "codex-oauth-org" });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<TestCodexOauthResponseBody>(
        client.create({
          query: {},
          body: {
            ...LEGACY_CODEX_OAUTH_BODY,
            expiresIn: 600,
            needsReconnect: true,
            lastRefreshErrorCode: "refresh_failed",
          },
        }),
        200,
      );

      expect(response.body.ok).toBeTruthy();
      expect(response.body.orgId).toBe(orgId);
      expect(response.body.tokenExpiresAt).toBeDefined();
      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: [DEFAULT_TEST_EMAIL],
      });

      const provider = await readOrgCodexOauthProviderState(orgId);
      expect(provider).toMatchObject({
        authMethod: "auth_json",
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_failed",
      });
      expect(provider?.tokenExpiresAt).toBeInstanceOf(Date);
      await expect(
        findOrgModelProviderSecret(orgId, "CHATGPT_ACCESS_TOKEN"),
      ).resolves.toBe(LEGACY_CODEX_OAUTH_BODY.accessToken);
      await expect(
        findOrgModelProviderSecret(orgId, "CHATGPT_REFRESH_TOKEN"),
      ).resolves.toBe(LEGACY_CODEX_OAUTH_BODY.refreshToken);
      await expect(
        findOrgModelProviderSecret(orgId, "CHATGPT_ACCOUNT_ID"),
      ).resolves.toBe(LEGACY_CODEX_OAUTH_BODY.accountId);
      await expect(
        findOrgModelProviderSecret(orgId, "CHATGPT_ID_TOKEN"),
      ).resolves.toBe(LEGACY_CODEX_OAUTH_BODY.idToken);
    });

    it("pre-expires legacy Codex OAuth token state when expiresIn is negative", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "codex-oauth-expired" });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      await acceptResponse<TestCodexOauthResponseBody>(
        client.create({
          query: {},
          body: { ...LEGACY_CODEX_OAUTH_BODY, expiresIn: -60 },
        }),
        200,
      );

      const provider = await readOrgCodexOauthProviderState(orgId);
      expect(provider?.tokenExpiresAt).toBeInstanceOf(Date);
      expect(provider!.tokenExpiresAt!.getTime()).toBeLessThan(now());
    });

    it("resolves a custom test user email through Clerk", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "codex-oauth-custom-email",
      });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      await acceptResponse<TestCodexOauthResponseBody>(
        client.create({
          query: { email: "custom@test.com" },
          body: LEGACY_CODEX_OAUTH_BODY,
        }),
        200,
      );

      expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
        emailAddress: ["custom@test.com"],
      });
    });

    it("seeds Codex OAuth token state through the auth_json paste path", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "codex-oauth-auth-json" });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<TestCodexOauthResponseBody>(
        client.create({
          query: {},
          body: { authJson: makeCodexAuthJson() },
        }),
        200,
      );

      expect(response.body.ok).toBeTruthy();
      expect(response.body.orgId).toBe(orgId);
      expect(response.body.tokenExpiresAt).toBeDefined();

      const provider = await readOrgCodexOauthProviderState(orgId);
      expect(provider).toMatchObject({
        authMethod: "auth_json",
        workspaceName: "Acme",
        planType: "plus",
        needsReconnect: false,
        lastRefreshErrorCode: null,
      });
      expect(provider?.tokenExpiresAt).toBeInstanceOf(Date);
      expect(provider!.tokenExpiresAt!.getTime()).toBeGreaterThan(now());

      await expect(
        findOrgModelProviderSecret(orgId, "CHATGPT_ACCOUNT_ID"),
      ).resolves.toBe("ws_acct_id_token");
      await expect(
        findOrgModelProviderSecret(orgId, "CHATGPT_REFRESH_TOKEN"),
      ).resolves.toBe("rt_synthetic_authjson_seed_high_entropy");
      await expect(
        findOrgModelProviderSecret(orgId, "CODEX_AUTH_JSON"),
      ).resolves.toBeUndefined();
    });

    it("rejects malformed authJson with the parser error", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "codex-oauth-malformed-auth-json",
      });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: { authJson: "{ not json" },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "auth.json shape invalid: auth.json is not valid JSON",
      });
    });

    it("rejects free-plan authJson with the legacy error", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({
        orgId,
        userId,
        slug: "codex-oauth-free-plan",
      });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestCodexOauthContract);

      const response = await acceptResponse<{ readonly error: string }>(
        client.create({
          query: {},
          body: { authJson: makeCodexAuthJson({ planType: "free" }) },
        }),
        400,
      );

      expect(response.body).toStrictEqual({
        error: "Free plan rejected by parser",
      });
    });
  });
});
