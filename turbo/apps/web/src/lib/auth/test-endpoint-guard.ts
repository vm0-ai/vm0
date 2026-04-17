import { env } from "../../env";

/**
 * Guard for test-only API endpoints. Returns true only in:
 * - Local dev (NODE_ENV=development, no VERCEL_ENV), OR
 * - Vercel preview with a matching x-vercel-protection-bypass header
 *
 * Returns false in production. Callers should 404 (not 403) when this
 * returns false — test endpoints should not reveal their existence.
 */
export function isTestEndpointAllowed(request: Request): boolean {
  const vercelEnv = env().VERCEL_ENV;
  const nodeEnv = env().NODE_ENV;

  if (!vercelEnv && nodeEnv === "development") {
    return true;
  }

  if (vercelEnv === "preview") {
    const bypassHeader = request.headers.get("x-vercel-protection-bypass");
    const expectedSecret = env().VERCEL_AUTOMATION_BYPASS_SECRET;
    return !!expectedSecret && bypassHeader === expectedSecret;
  }

  return false;
}
