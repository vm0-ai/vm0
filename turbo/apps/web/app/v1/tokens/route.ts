/**
 * Public API v1 - Tokens Endpoints
 *
 * GET /v1/tokens - List user's API tokens
 * POST /v1/tokens - Create new API token
 */
import { initServices } from "../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../src/lib/public-api/handler";
import { publicTokensListContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../src/lib/public-api/auth";
import { cliTokens } from "../../../src/db/schema/cli-tokens";
import { eq, and, desc, gt } from "drizzle-orm";
import { randomBytes } from "crypto";

/**
 * Generate a new API token with prefix
 * Format: vm0_live_<32 random bytes in hex>
 */
function generateApiToken(): string {
  const randomPart = randomBytes(32).toString("hex");
  return `vm0_live_${randomPart}`;
}

/**
 * Extract token prefix for display (first 12 chars)
 */
function getTokenPrefix(token: string): string {
  return token.substring(0, 16) + "...";
}

const router = tsr.router(publicTokensListContract, {
  list: async ({ query }) => {
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

    // Build query conditions - filter by user
    const conditions = [eq(cliTokens.userId, auth.userId)];

    // Handle cursor-based pagination
    if (query.cursor) {
      conditions.push(gt(cliTokens.id, query.cursor));
    }

    const limit = query.limit ?? 20;

    // Fetch tokens
    const tokens = await globalThis.services.db
      .select()
      .from(cliTokens)
      .where(and(...conditions))
      .orderBy(desc(cliTokens.createdAt))
      .limit(limit + 1);

    // Determine pagination info
    const hasMore = tokens.length > limit;
    const data = hasMore ? tokens.slice(0, limit) : tokens;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return {
      status: 200 as const,
      body: {
        data: data.map((token) => ({
          id: token.id,
          name: token.name,
          token_prefix: getTokenPrefix(token.token),
          last_used_at: token.lastUsedAt?.toISOString() ?? null,
          expires_at: token.expiresAt.toISOString(),
          created_at: token.createdAt.toISOString(),
        })),
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },

  create: async ({ body }) => {
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

    const { name, expires_in_days } = body;

    // Calculate expiry date (default 90 days)
    const expiryDays = expires_in_days ?? 90;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    // Generate new token
    const token = generateApiToken();

    // Insert token into database
    const [newToken] = await globalThis.services.db
      .insert(cliTokens)
      .values({
        token,
        userId: auth.userId,
        name,
        expiresAt,
      })
      .returning();

    if (!newToken) {
      return {
        status: 400 as const,
        body: {
          error: {
            type: "invalid_request_error" as const,
            code: "internal_error",
            message: "Failed to create token",
          },
        },
      };
    }

    return {
      status: 201 as const,
      body: {
        id: newToken.id,
        name: newToken.name,
        token_prefix: getTokenPrefix(newToken.token),
        token, // Full token value - only returned on creation!
        last_used_at: null,
        expires_at: newToken.expiresAt.toISOString(),
        created_at: newToken.createdAt.toISOString(),
      },
    };
  },
});

const handler = createPublicApiHandler(publicTokensListContract, router);

export { handler as GET, handler as POST };
