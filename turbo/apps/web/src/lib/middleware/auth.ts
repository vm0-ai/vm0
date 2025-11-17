import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { UnauthorizedError } from "../errors";
import { apiKeys } from "../../db/schema/api-key";

/**
 * Hash API key using SHA-256
 */
function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Authenticate request using API key
 * @throws UnauthorizedError if authentication fails
 */
export async function authenticate(request: NextRequest): Promise<string> {
  const apiKey = request.headers.get("x-api-key");

  if (!apiKey) {
    throw new UnauthorizedError("Missing API key");
  }

  const keyHash = hashApiKey(apiKey);

  // Find API key in database
  const [apiKeyRecord] = await globalThis.services.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (!apiKeyRecord) {
    throw new UnauthorizedError("Invalid API key");
  }

  // Update last used timestamp
  await globalThis.services.db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKeyRecord.id));

  return apiKeyRecord.id;
}
