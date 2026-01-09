/**
 * API Token Service
 *
 * Manages API tokens for the public API v1.
 * Tokens are prefixed with `vm0_api_` and stored as SHA-256 hashes.
 */
import { createHash, randomBytes } from "crypto";
import { eq, and, isNull, gt, desc } from "drizzle-orm";
import { initServices } from "../init-services";
import { apiTokens } from "../../db/schema/api-tokens";
import { TOKEN_PREFIXES, type ApiScope } from "@vm0/core";
import { logger } from "../logger";

const log = logger("api-token");

/**
 * Token length (excluding prefix)
 */
const TOKEN_RANDOM_BYTES = 32; // 64 hex chars

/**
 * Hash a token using SHA-256
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a new API token
 * Returns the full token value (only available once)
 */
function generateToken(): string {
  const randomPart = randomBytes(TOKEN_RANDOM_BYTES).toString("hex");
  return `${TOKEN_PREFIXES.API}${randomPart}`;
}

/**
 * Parse expiration string to Date
 */
function parseExpiration(expiresIn: string): Date | null {
  if (expiresIn === "never") return null;

  const match = expiresIn.match(/^(\d+)([dhmy])$/);
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  const unit = match[2];

  const now = new Date();
  switch (unit) {
    case "d":
      now.setDate(now.getDate() + value);
      break;
    case "h":
      now.setHours(now.getHours() + value);
      break;
    case "m":
      now.setMonth(now.getMonth() + value);
      break;
    case "y":
      now.setFullYear(now.getFullYear() + value);
      break;
    default:
      return null;
  }

  return now;
}

/**
 * Create a new API token
 *
 * @returns The token details including the full token value (only returned once!)
 */
export async function createApiToken(
  userId: string,
  name: string,
  scopes: ApiScope[],
  expiresIn: string = "90d",
): Promise<{
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  createdAt: Date;
}> {
  initServices();

  const token = generateToken();
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 12); // "vm0_api_xxxx"
  const expiresAt = parseExpiration(expiresIn);

  const [result] = await globalThis.services.db
    .insert(apiTokens)
    .values({
      userId,
      name,
      tokenHash,
      tokenPrefix,
      scopes: JSON.stringify(scopes),
      expiresAt,
    })
    .returning();

  if (!result) {
    throw new Error("Failed to create API token");
  }

  log.debug("Created API token", { userId, tokenPrefix, scopes });

  return {
    id: result.id,
    name: result.name,
    token, // Full token value - ONLY returned here!
    tokenPrefix: result.tokenPrefix,
    scopes,
    expiresAt: result.expiresAt,
    createdAt: result.createdAt,
  };
}

/**
 * Validate an API token
 *
 * @returns Token details if valid, null if invalid/expired/revoked
 */
export async function validateApiToken(token: string): Promise<{
  id: string;
  userId: string;
  scopes: ApiScope[];
} | null> {
  if (!token.startsWith(TOKEN_PREFIXES.API)) {
    return null;
  }

  initServices();

  const tokenHash = hashToken(token);

  const [result] = await globalThis.services.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
    .limit(1);

  if (!result) {
    return null;
  }

  // Check expiration
  if (result.expiresAt && result.expiresAt < new Date()) {
    log.debug("API token expired", { tokenId: result.id });
    return null;
  }

  // Update last used timestamp (non-blocking)
  globalThis.services.db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, result.id))
    .catch((err) => log.error("Failed to update token lastUsedAt:", err));

  const scopes = JSON.parse(result.scopes) as ApiScope[];

  return {
    id: result.id,
    userId: result.userId,
    scopes,
  };
}

/**
 * List API tokens for a user
 */
export async function listApiTokens(
  userId: string,
  options?: {
    limit?: number;
    cursor?: string;
  },
): Promise<{
  tokens: Array<{
    id: string;
    name: string;
    tokenPrefix: string;
    scopes: ApiScope[];
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  initServices();

  const limit = options?.limit ?? 20;
  const cursor = options?.cursor;

  const query = globalThis.services.db
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
        cursor ? gt(apiTokens.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(apiTokens.createdAt))
    .limit(limit + 1); // Fetch one extra to check if there are more

  const results = await query;

  const hasMore = results.length > limit;
  const tokens = results.slice(0, limit);

  return {
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix,
      scopes: JSON.parse(t.scopes) as ApiScope[],
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
    })),
    hasMore,
    nextCursor:
      hasMore && tokens.length > 0 ? tokens[tokens.length - 1]!.id : null,
  };
}

/**
 * Get a single API token by ID
 */
export async function getApiToken(
  tokenId: string,
  userId: string,
): Promise<{
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiScope[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
} | null> {
  initServices();

  const [result] = await globalThis.services.db
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .limit(1);

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    name: result.name,
    tokenPrefix: result.tokenPrefix,
    scopes: JSON.parse(result.scopes) as ApiScope[],
    lastUsedAt: result.lastUsedAt,
    expiresAt: result.expiresAt,
    createdAt: result.createdAt,
  };
}

/**
 * Revoke an API token
 */
export async function revokeApiToken(
  tokenId: string,
  userId: string,
): Promise<boolean> {
  initServices();

  const result = await globalThis.services.db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning({ id: apiTokens.id });

  if (result.length > 0) {
    log.debug("Revoked API token", { tokenId, userId });
    return true;
  }

  return false;
}

/**
 * Check if a token has a specific scope
 */
export function hasScope(
  tokenScopes: ApiScope[],
  requiredScope: ApiScope,
): boolean {
  return tokenScopes.includes(requiredScope);
}

/**
 * Check if a token has any of the required scopes
 */
export function hasAnyScope(
  tokenScopes: ApiScope[],
  requiredScopes: ApiScope[],
): boolean {
  return requiredScopes.some((scope) => tokenScopes.includes(scope));
}

/**
 * Check if a token has all required scopes
 */
export function hasAllScopes(
  tokenScopes: ApiScope[],
  requiredScopes: ApiScope[],
): boolean {
  return requiredScopes.every((scope) => tokenScopes.includes(scope));
}
