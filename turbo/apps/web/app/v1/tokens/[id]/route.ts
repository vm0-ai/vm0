/**
 * Public API v1 - Token by ID Endpoints
 *
 * GET /v1/tokens/:id - Get token details (without secret)
 * DELETE /v1/tokens/:id - Revoke token
 */
import { initServices } from "../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../src/lib/public-api/handler";
import { publicTokenByIdContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../src/lib/public-api/auth";
import { cliTokens } from "../../../../src/db/schema/cli-tokens";
import { eq, and } from "drizzle-orm";

/**
 * Extract token prefix for display (first 12 chars)
 */
function getTokenPrefix(token: string): string {
  return token.substring(0, 16) + "...";
}

const router = tsr.router(publicTokenByIdContract, {
  get: async ({ params }) => {
    initServices();

    const auth = await authenticatePublicApi();
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Find token by ID, ensuring it belongs to user
    const [token] = await globalThis.services.db
      .select()
      .from(cliTokens)
      .where(
        and(eq(cliTokens.id, params.id), eq(cliTokens.userId, auth.userId)),
      )
      .limit(1);

    if (!token) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such token: '${params.id}'`,
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        id: token.id,
        name: token.name,
        token_prefix: getTokenPrefix(token.token),
        last_used_at: token.lastUsedAt?.toISOString() ?? null,
        expires_at: token.expiresAt.toISOString(),
        created_at: token.createdAt.toISOString(),
      },
    };
  },

  delete: async ({ params }) => {
    initServices();

    const auth = await authenticatePublicApi();
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Find token by ID, ensuring it belongs to user
    const [token] = await globalThis.services.db
      .select()
      .from(cliTokens)
      .where(
        and(eq(cliTokens.id, params.id), eq(cliTokens.userId, auth.userId)),
      )
      .limit(1);

    if (!token) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such token: '${params.id}'`,
          },
        },
      };
    }

    // Delete the token
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.id, token.id));

    return {
      status: 204 as const,
      body: undefined,
    };
  },
});

const handler = createPublicApiHandler(publicTokenByIdContract, router);

export { handler as GET, handler as DELETE };
