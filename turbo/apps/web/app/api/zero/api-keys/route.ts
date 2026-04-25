import crypto from "crypto";
import { desc, eq } from "drizzle-orm";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { apiKeysContract } from "@vm0/api-contracts/contracts/api-keys";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { generateCliToken } from "../../../../src/lib/auth/sandbox-token";
import { isApiError } from "../../../../src/lib/shared/errors";

const PREFIX_LENGTH = 12;

function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LENGTH) + "…";
}

const router = tsr.router(apiKeysContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const rows = await globalThis.services.db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.userId, authCtx.userId))
      .orderBy(desc(cliTokens.createdAt));

    return {
      status: 200 as const,
      body: {
        apiKeys: rows.map((row) => {
          return {
            id: row.id,
            name: row.name,
            tokenPrefix: tokenPrefix(row.token),
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          };
        }),
      },
    };
  },

  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isApiError(error)) {
        return {
          status: error.statusCode as 400 | 401 | 500,
          body: { error: { message: error.message, code: error.code } },
        };
      }
      throw error;
    }

    const tokenId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000,
    );
    const token = await generateCliToken(authCtx.userId, orgId, tokenId);

    await globalThis.services.db.insert(cliTokens).values({
      id: tokenId,
      token,
      userId: authCtx.userId,
      name: body.name,
      expiresAt,
      createdAt: now,
    });

    return {
      status: 201 as const,
      body: {
        id: tokenId,
        name: body.name,
        tokenPrefix: tokenPrefix(token),
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastUsedAt: null,
        token,
      },
    };
  },
});

const handler = createHandler(apiKeysContract, router, {
  routeName: "zero.api-keys",
  errorHandler: createSafeErrorHandler("zero-api-keys"),
});

export { handler as GET, handler as POST };
