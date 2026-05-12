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

import { setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { signPatJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import { DEFAULT_TEST_EMAIL } from "../../services/cli-auth.service";

const context = testContext();
const store = createStore();
const ORG_SENTINEL_USER_ID = "__org__";

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

  async function seedOrgMembership(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly slug: string;
    readonly role?: "admin" | "member";
  }): Promise<void> {
    trackOrg(args.orgId);
    trackUser(args.userId);
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

  beforeEach(() => {
    mockEnv("ENV", "development");
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

      expect(response.body.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(response.body.user_code).toBe(response.body.device_code);
      expect(response.body.verification_path).toBe("/cli-auth");
      expect(response.body.expires_in).toBe(900);
      expect(response.body.interval).toBe(5);

      const row = await fetchDeviceCode(response.body.device_code);
      expect(row).toMatchObject({ purpose: "cli", status: "pending" });
    });
  });

  describe("POST /api/cli/auth/token", () => {
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
      await expect(fetchDeviceCode(code)).resolves.toBeUndefined();
      await expect(
        fetchCliToken(response.body.access_token),
      ).resolves.toMatchObject({
        userId,
        name: "CLI Device Flow Authentication",
      });
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
  });

  describe("POST /api/cli/auth/test-approve", () => {
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
          body: { device_code: deviceResponse.body.device_code.toLowerCase() },
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
  });

  describe("POST /api/cli/auth/test-connector", () => {
    it("seeds an OAuth connector for the test user org", async () => {
      const userId = trackUser(`user_${randomUUID()}`);
      const orgId = trackOrg(`org_${randomUUID()}`);
      await seedOrgMembership({ orgId, userId, slug: "connector-org" });
      mockTestUser({ userId, orgId });
      const client = setupApp({ context })(cliAuthTestConnectorContract);

      const response = await acceptResponse<TestConnectorResponseBody>(
        client.create({
          query: {},
          body: {
            connectorName: "github",
            accessToken: "github-access-token",
            refreshToken: "github-refresh-token",
            expiresIn: 3600,
          },
        }),
        200,
      );

      expect(response.body).toStrictEqual({
        ok: true,
        connectorType: "github",
        orgId,
      });

      const writeDb = store.set(writeDb$);
      await expect(
        writeDb
          .select()
          .from(connectors)
          .where(
            and(
              eq(connectors.orgId, orgId),
              eq(connectors.userId, userId),
              eq(connectors.type, "github"),
            ),
          )
          .limit(1),
      ).resolves.toHaveLength(1);

      const computerResponse = await acceptResponse<TestConnectorResponseBody>(
        client.create({
          query: {},
          body: {
            connectorName: "computer",
            accessToken: "computer-access-token",
          },
        }),
        200,
      );

      expect(computerResponse.body).toStrictEqual({
        ok: true,
        connectorType: "computer",
        orgId,
      });
      await expect(
        writeDb
          .select()
          .from(connectors)
          .where(
            and(
              eq(connectors.orgId, orgId),
              eq(connectors.userId, userId),
              eq(connectors.type, "computer"),
            ),
          )
          .limit(1),
      ).resolves.toHaveLength(1);
    });
  });

  describe("POST /api/cli/auth/test-enable-connector", () => {
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
  });

  describe("POST /api/cli/auth/test-codex-oauth", () => {
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
            accessToken: "codex-access-token",
            refreshToken: "codex-refresh-token",
            accountId: "codex-account",
            idToken: "codex-id-token",
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

      const writeDb = store.set(writeDb$);
      const [provider] = await writeDb
        .select()
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, orgId),
            eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
            eq(modelProviders.type, "codex-oauth-token"),
          ),
        )
        .limit(1);
      expect(provider).toMatchObject({
        authMethod: "auth_json",
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_failed",
      });
      expect(provider?.tokenExpiresAt).toBeInstanceOf(Date);
    });
  });
});
