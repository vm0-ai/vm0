import { NextRequest } from "next/server";
import { UnauthorizedError } from "./errors";

/**
 * Validate webhook token
 *
 * MVP: Simple token validation
 * Future: JWT-based tokens with expiration
 */
export async function validateWebhookToken(
  request: NextRequest,
  runtimeId: string,
): Promise<void> {
  const token = request.headers.get("x-vm0-token");

  if (!token) {
    throw new UnauthorizedError("Missing webhook token");
  }

  // MVP: Validate token format
  // Format: "rt-{runtimeId}-{random}"
  // This allows E2B sandbox to authenticate without database lookup
  const expectedPrefix = `rt-${runtimeId}-`;

  if (!token.startsWith(expectedPrefix)) {
    throw new UnauthorizedError("Invalid webhook token");
  }

  // Token is valid if it matches the runtime ID
  // In production, consider:
  // - Time-based expiration
  // - Cryptographic signing
  // - Database-backed token storage
}

/**
 * Generate webhook token for a runtime
 * This should be called when creating a runtime
 */
export function generateWebhookToken(runtimeId: string): string {
  const randomPart = Math.random().toString(36).substring(2, 15);
  return `rt-${runtimeId}-${randomPart}`;
}
