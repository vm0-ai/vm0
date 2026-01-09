/**
 * API Token Service
 *
 * Manages API tokens for the public API v1.
 * Reuses the existing cli_tokens table with vm0_api_ prefix.
 */
import { randomBytes } from "crypto";
import { eq, and, gt, desc } from "drizzle-orm";
import { initServices } from "../init-services";
import { cliTokens } from "../../db/schema/cli-tokens";
import { TOKEN_PREFIXES } from "@vm0/core";
import { logger } from "../logger";

const log = logger("api-token");

/**
 * Token length (excluding prefix)
 */
const TOKEN_RANDOM_BYTES = 32; // 64 hex chars

/**
 * Default token expiration: 90 days
 */
const DEFAULT_EXPIRATION_DAYS = 90;

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
function parseExpiration(expiresIn: string): Date {
  if (expiresIn === "never") {
    // Set to 100 years from now for "never"
    const date = new Date();
    date.setFullYear(date.getFullYear() + 100);
    return date;
  }

  const match = expiresIn.match(/^(\d+)([dhmy])$/);
  if (!match) {
    // Default to 90 days
    const date = new Date();
    date.setDate(date.getDate() + DEFAULT_EXPIRATION_DAYS);
    return date;
  }

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
      now.setDate(now.getDate() + DEFAULT_EXPIRATION_DAYS);
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
  expiresIn: string = "90d",
): Promise<{
  id: string;
  name: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}> {
  initServices();

  const token = generateToken();
  const expiresAt = parseExpiration(expiresIn);

  const [result] = await globalThis.services.db
    .insert(cliTokens)
    .values({
      userId,
      name,
      token,
      expiresAt,
    })
    .returning();

  if (!result) {
    throw new Error("Failed to create API token");
  }

  log.debug("Created API token", {
    userId,
    tokenPrefix: token.substring(0, 12),
  });

  return {
    id: result.id,
    name: result.name,
    token, // Full token value - ONLY returned here!
    expiresAt: result.expiresAt,
    createdAt: result.createdAt,
  };
}

/**
 * Validate an API token
 *
 * @returns Token details if valid, null if invalid/expired
 */
export async function validateApiToken(token: string): Promise<{
  id: string;
  userId: string;
} | null> {
  if (!token.startsWith(TOKEN_PREFIXES.API)) {
    return null;
  }

  initServices();

  const [result] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(and(eq(cliTokens.token, token), gt(cliTokens.expiresAt, new Date())))
    .limit(1);

  if (!result) {
    return null;
  }

  // Update last used timestamp (non-blocking)
  globalThis.services.db
    .update(cliTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(cliTokens.id, result.id))
    .catch((err) => log.error("Failed to update token lastUsedAt:", err));

  return {
    id: result.id,
    userId: result.userId,
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
    lastUsedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  initServices();

  const limit = options?.limit ?? 20;
  const cursor = options?.cursor;

  // Only list API tokens (vm0_api_*), not CLI tokens (vm0_live_*)
  const results = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(
      and(
        eq(cliTokens.userId, userId),
        cursor ? gt(cliTokens.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(cliTokens.createdAt))
    .limit(limit + 1);

  // Filter to only API tokens
  const apiTokenResults = results.filter((t) =>
    t.token.startsWith(TOKEN_PREFIXES.API),
  );

  const hasMore = apiTokenResults.length > limit;
  const tokens = apiTokenResults.slice(0, limit);

  return {
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.token.substring(0, 12), // "vm0_api_xxxx"
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
  lastUsedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
} | null> {
  initServices();

  const [result] = await globalThis.services.db
    .select()
    .from(cliTokens)
    .where(and(eq(cliTokens.id, tokenId), eq(cliTokens.userId, userId)))
    .limit(1);

  if (!result) {
    return null;
  }

  // Only return API tokens
  if (!result.token.startsWith(TOKEN_PREFIXES.API)) {
    return null;
  }

  return {
    id: result.id,
    name: result.name,
    tokenPrefix: result.token.substring(0, 12),
    lastUsedAt: result.lastUsedAt,
    expiresAt: result.expiresAt,
    createdAt: result.createdAt,
  };
}

/**
 * Revoke (delete) an API token
 */
export async function revokeApiToken(
  tokenId: string,
  userId: string,
): Promise<boolean> {
  initServices();

  // First check if it's an API token
  const existing = await getApiToken(tokenId, userId);
  if (!existing) {
    return false;
  }

  const result = await globalThis.services.db
    .delete(cliTokens)
    .where(and(eq(cliTokens.id, tokenId), eq(cliTokens.userId, userId)))
    .returning({ id: cliTokens.id });

  if (result.length > 0) {
    log.debug("Revoked API token", { tokenId, userId });
    return true;
  }

  return false;
}
