import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { apiKeysContract } from "@vm0/api-contracts/contracts/api-keys";
import { cliTokens } from "@vm0/db/schema/cli-tokens";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { generateCliToken } from "../auth/tokens";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route";
import { userApiKeys } from "../services/zero-user-data.service";
import { zeroApiKeysDeleteRoutes } from "./zero-api-keys-delete";

const API_KEY_PREFIX_LENGTH = 12;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const createApiKeyBody$ = bodyResultOf(apiKeysContract.create);

function tokenPrefix(token: string): string {
  return `${token.slice(0, API_KEY_PREFIX_LENGTH)}\u2026`;
}

const listApiKeysInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(authContext$);
  const body = await get(userApiKeys(auth.userId));
  return {
    status: 200 as const,
    body,
  };
});

const createApiKeyInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(createApiKeyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const tokenId = randomUUID();
    const createdAt = nowDate();
    const expiresAt = new Date(
      createdAt.getTime() + bodyResult.data.expiresInDays * MS_PER_DAY,
    );
    const token = generateCliToken(auth.userId, auth.orgId, tokenId);

    const writeDb = set(writeDb$);
    await writeDb.insert(cliTokens).values({
      id: tokenId,
      token,
      userId: auth.userId,
      name: bodyResult.data.name,
      expiresAt,
      createdAt,
    });
    signal.throwIfAborted();

    return {
      status: 201 as const,
      body: {
        id: tokenId,
        name: bodyResult.data.name,
        tokenPrefix: tokenPrefix(token),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastUsedAt: null,
        token,
      },
    };
  },
);

export const zeroApiKeysRoutes: readonly RouteEntry[] = [
  {
    route: apiKeysContract.list,
    handler: authRoute({}, listApiKeysInner$),
  },
  {
    route: apiKeysContract.create,
    handler: authRoute({ requireOrganization: true }, createApiKeyInner$),
  },
  ...zeroApiKeysDeleteRoutes,
];
