import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifySandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { decryptSecretsMap } from "../../../../../../src/lib/crypto/secrets-encryption";
import { logger } from "../../../../../../src/lib/logger";

const bodySchema = z.object({
  encryptedSecrets: z.string().min(1),
  authHeaders: z.record(z.string(), z.string()),
});

const log = logger("webhook:service-auth");

/**
 * POST /api/webhooks/agent/services/auth
 *
 * Pure decrypter/template resolver for service auth headers.
 * Called by the mitmproxy addon when it intercepts a service-matched request.
 *
 * Auth: Sandbox JWT
 * Body: { encryptedSecrets: string, authHeaders: Record<string, string> }
 * Response: { headers: Record<string, string> }
 */
export async function POST(request: Request) {
  initServices();

  // Authenticate via sandbox JWT
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json(
      { error: { message: "Missing authorization", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const auth = verifySandboxToken(token);
  if (!auth) {
    return NextResponse.json(
      { error: { message: "Invalid token", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  // Parse request body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          message: "encryptedSecrets and authHeaders are required",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const { encryptedSecrets, authHeaders } = parsed.data;

  // Decrypt secrets
  let secrets: Record<string, string> | null;
  try {
    secrets = decryptSecretsMap(
      encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );
  } catch {
    secrets = null;
  }
  if (!secrets) {
    return NextResponse.json(
      { error: { message: "Failed to decrypt secrets", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // Resolve ${secrets.XXX} templates with decrypted values
  const resolved: Record<string, string> = {};
  for (const [name, template] of Object.entries(authHeaders)) {
    resolved[name] = template.replace(
      /\$\{secrets\.([^}]+)\}/g,
      (_match, key: string) => {
        if (!(key in secrets)) {
          log.warn(`[${auth.runId}] No secret value for "${key}" in template`);
          return "";
        }
        return secrets[key] ?? "";
      },
    );
  }

  return NextResponse.json({ headers: resolved });
}
