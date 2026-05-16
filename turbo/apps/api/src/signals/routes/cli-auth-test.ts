import { optionalEnv } from "../../lib/env";
import {
  cliAuthTestApproveContract,
  cliAuthTestCodexOauthContract,
  cliAuthTestConnectorContract,
  cliAuthTestEnableConnectorContract,
  cliAuthTestTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth-test";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import { PROVIDER_HANDLERS } from "@vm0/connectors/oauth-providers";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { deviceCodes } from "@vm0/db/schema/device-codes";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";
import {
  DEFAULT_TEST_EMAIL,
  issueCliToken$,
  testUserId,
  testUserOrgId,
  ensureTestOrg$,
} from "../services/cli-auth.service";
import { upsertOAuthConnector$ } from "../services/zero-connector-data.service";
import { upsertOrgMultiAuthModelProvider$ } from "../services/zero-model-provider.service";
import {
  isCodexAuthJsonFreePlanError,
  isCodexAuthJsonShapeError,
  parseCodexAuthJson,
} from "../services/codex-auth-json-parser";
import { settle } from "../utils";

const ORG_SENTINEL_USER_ID = "__org__";

const testApproveBody$ = bodyResultOf(cliAuthTestApproveContract.approve);
const testApproveQuery$ = queryOf(cliAuthTestApproveContract.approve);
const testTokenQuery$ = queryOf(cliAuthTestTokenContract.create);
const testConnectorBody$ = bodyResultOf(cliAuthTestConnectorContract.create);
const testConnectorQuery$ = queryOf(cliAuthTestConnectorContract.create);
const testEnableConnectorBody$ = bodyResultOf(
  cliAuthTestEnableConnectorContract.create,
);
const testEnableConnectorQuery$ = queryOf(
  cliAuthTestEnableConnectorContract.create,
);
const testCodexOauthBody$ = bodyResultOf(cliAuthTestCodexOauthContract.create);
const testCodexOauthQuery$ = queryOf(cliAuthTestCodexOauthContract.create);

function stringError(status: 400 | 404, error: string) {
  return { status, body: { error } };
}

function testEndpointAllowed(request: {
  header: (name: string) => string | undefined;
}) {
  return isTestEndpointAllowed(request);
}

const approveDeviceForTest$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (optionalEnv("USE_MOCK_CLAUDE") !== "true") {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(testApproveBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return stringError(400, "device_code required");
    }

    const deviceCode = bodyResult.data.device_code;
    if (!deviceCode) {
      return stringError(400, "device_code required");
    }

    const normalizedCode = deviceCode.toUpperCase();
    const writeDb = set(writeDb$);
    const [session] = await writeDb
      .select()
      .from(deviceCodes)
      .where(
        and(
          eq(deviceCodes.code, normalizedCode),
          eq(deviceCodes.purpose, "cli"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return new Response("Not found", { status: 404 });
    }
    if (session.status !== "pending") {
      return stringError(400, "Device code is not in pending status");
    }
    if (nowDate() > session.expiresAt) {
      return stringError(400, "Device code has expired");
    }

    const query = get(testApproveQuery$);
    const userId = await get(testUserId(query.email ?? DEFAULT_TEST_EMAIL));
    signal.throwIfAborted();

    await writeDb
      .update(deviceCodes)
      .set({ status: "authenticated", userId, updatedAt: nowDate() })
      .where(eq(deviceCodes.code, normalizedCode));
    signal.throwIfAborted();

    return { status: 200 as const, body: { success: true as const, userId } };
  },
);

const createTestToken$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!testEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const query = get(testTokenQuery$);
  const userId = await get(testUserId(query.email ?? DEFAULT_TEST_EMAIL));
  signal.throwIfAborted();
  const { orgId } = await set(ensureTestOrg$, userId, signal);
  signal.throwIfAborted();
  const issued = await set(
    issueCliToken$,
    { userId, orgId, name: "CI Test Token" },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      access_token: issued.token,
      token_type: "Bearer" as const,
      expires_in: issued.expiresIn,
      user_id: userId,
    },
  };
});

async function testOrgForUser(
  get: <T>(value: import("ccstate").Computed<T>) => T,
  userId: string,
): Promise<string | null> {
  return await get(testUserOrgId(userId));
}

const createTestConnector$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!testEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(testConnectorBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return stringError(400, "connectorName and accessToken are required");
    }

    const connectorParsed = connectorTypeSchema.safeParse(
      bodyResult.data.connectorName,
    );
    if (!connectorParsed.success) {
      return stringError(
        400,
        `Unknown connector type: "${bodyResult.data.connectorName}"`,
      );
    }
    const connectorType = connectorParsed.data;

    const query = get(testConnectorQuery$);
    const userId = await get(testUserId(query.email ?? DEFAULT_TEST_EMAIL));
    signal.throwIfAborted();
    const orgId = await testOrgForUser(get, userId);
    signal.throwIfAborted();
    if (!orgId) {
      return stringError(400, "Test user has no org — run test-token first");
    }

    const refreshSecretName =
      connectorType === "computer"
        ? undefined
        : PROVIDER_HANDLERS[connectorType].getRefreshSecretName?.();
    await set(
      upsertOAuthConnector$,
      {
        orgId,
        userId,
        type: connectorType,
        accessToken: bodyResult.data.accessToken,
        userInfo: {
          id: `e2e-test-${connectorType}`,
          username: `e2e-${connectorType}`,
          email: `e2e-${connectorType}@test.vm0.ai`,
        },
        oauthScopes: [],
        refreshToken: bodyResult.data.refreshToken,
        refreshSecretName,
        expiresIn: bodyResult.data.expiresIn,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { ok: true as const, connectorType, orgId },
    };
  },
);

const enableTestConnectors$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!testEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(testEnableConnectorBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return stringError(400, "composeId and connectorTypes are required");
    }

    const invalidTypes = bodyResult.data.connectorTypes.filter((type) => {
      return !connectorTypeSchema.safeParse(type).success;
    });
    if (invalidTypes.length > 0) {
      return stringError(
        400,
        `Unknown connector types: ${invalidTypes.join(", ")}`,
      );
    }

    const query = get(testEnableConnectorQuery$);
    const userId = await get(testUserId(query.email ?? DEFAULT_TEST_EMAIL));
    signal.throwIfAborted();
    const orgId = await testOrgForUser(get, userId);
    signal.throwIfAborted();
    if (!orgId) {
      return stringError(400, "Test user has no org — run test-token first");
    }

    const writeDb = set(writeDb$);
    const [compose] = await writeDb
      .select({
        id: agentComposes.id,
        orgId: agentComposes.orgId,
        userId: agentComposes.userId,
        name: agentComposes.name,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, bodyResult.data.composeId))
      .limit(1);
    signal.throwIfAborted();

    if (!compose) {
      return stringError(
        404,
        `Compose not found: ${bodyResult.data.composeId}`,
      );
    }

    await writeDb
      .insert(zeroAgents)
      .values({
        id: compose.id,
        orgId: compose.orgId,
        owner: compose.userId,
        name: compose.name,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    await writeDb.insert(userConnectors).values(
      bodyResult.data.connectorTypes.map((connectorType) => {
        return {
          orgId,
          userId,
          agentId: compose.id,
          connectorType,
        };
      }),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        composeId: bodyResult.data.composeId,
        connectorTypes: bodyResult.data.connectorTypes,
      },
    };
  },
);

const seedCodexOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!testEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(testCodexOauthBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return stringError(400, "Invalid body shape");
  }

  const query = get(testCodexOauthQuery$);
  const userId = await get(testUserId(query.email ?? DEFAULT_TEST_EMAIL));
  signal.throwIfAborted();
  const orgId = await testOrgForUser(get, userId);
  signal.throwIfAborted();
  if (!orgId) {
    return stringError(400, "Test user has no org — run test-token first");
  }

  if ("authJson" in bodyResult.data) {
    const { authJson } = bodyResult.data;
    // parseCodexAuthJson is synchronous and throws on invalid input — wrap
    // in an async IIFE so the throw becomes a rejection settle can observe.
    const parsedResult = await settle(
      (async (): Promise<ReturnType<typeof parseCodexAuthJson>> => {
        await Promise.resolve();
        return parseCodexAuthJson(authJson);
      })(),
    );
    signal.throwIfAborted();
    if (!parsedResult.ok) {
      if (isCodexAuthJsonFreePlanError(parsedResult.error)) {
        return stringError(400, "Free plan rejected by parser");
      }
      if (isCodexAuthJsonShapeError(parsedResult.error)) {
        return stringError(
          400,
          `auth.json shape invalid: ${parsedResult.error.message}`,
        );
      }
      throw parsedResult.error;
    }

    const parsed = parsedResult.value;
    await set(
      upsertOrgMultiAuthModelProvider$,
      {
        orgId,
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secretValues: {
          CHATGPT_ACCESS_TOKEN: parsed.accessToken,
          CHATGPT_REFRESH_TOKEN: parsed.refreshToken,
          CHATGPT_ACCOUNT_ID: parsed.accountId,
          CHATGPT_ID_TOKEN: parsed.idToken,
        },
        metadata: {
          tokenExpiresAt: parsed.tokenExpiresAt,
          workspaceName: parsed.workspaceName,
          planType: parsed.planType,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        ok: true as const,
        orgId,
        tokenExpiresAt: parsed.tokenExpiresAt.toISOString(),
      },
    };
  }

  const tokenExpiresAt = new Date(
    nowDate().getTime() + (bodyResult.data.expiresIn ?? 600) * 1000,
  );
  await set(
    upsertOrgMultiAuthModelProvider$,
    {
      orgId,
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secretValues: {
        CHATGPT_ACCESS_TOKEN: bodyResult.data.accessToken,
        CHATGPT_REFRESH_TOKEN: bodyResult.data.refreshToken,
        CHATGPT_ACCOUNT_ID: bodyResult.data.accountId,
        CHATGPT_ID_TOKEN: bodyResult.data.idToken,
      },
      metadata: { tokenExpiresAt },
    },
    signal,
  );
  signal.throwIfAborted();

  const writeDb = set(writeDb$);
  await writeDb
    .update(modelProviders)
    .set({
      tokenExpiresAt,
      needsReconnect: bodyResult.data.needsReconnect ?? false,
      lastRefreshErrorCode: bodyResult.data.lastRefreshErrorCode ?? null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, "codex-oauth-token"),
      ),
    );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      orgId,
      tokenExpiresAt: tokenExpiresAt.toISOString(),
    },
  };
});

export const cliAuthTestRoutes: readonly RouteEntry[] = [
  { route: cliAuthTestApproveContract.approve, handler: approveDeviceForTest$ },
  { route: cliAuthTestTokenContract.create, handler: createTestToken$ },
  { route: cliAuthTestConnectorContract.create, handler: createTestConnector$ },
  {
    route: cliAuthTestEnableConnectorContract.create,
    handler: enableTestConnectors$,
  },
  { route: cliAuthTestCodexOauthContract.create, handler: seedCodexOauth$ },
];
