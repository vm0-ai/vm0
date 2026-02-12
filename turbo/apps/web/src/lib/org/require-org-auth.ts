import { resolveOrgAccessToken } from "./org-token-service";

interface OrgAuth {
  userId: string;
  scopeId: string;
  role: string;
}

interface OrgAuthError {
  message: string;
  code: string;
  status: 401 | 403;
}

type OrgAuthResult =
  | { ok: true; auth: OrgAuth }
  | { ok: false; error: OrgAuthError };

/**
 * Validate an org access token from the Authorization header.
 * Returns the resolved auth context or a structured error.
 */
export async function requireOrgAuth(
  authHeader: string | undefined,
): Promise<OrgAuthResult> {
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  if (!token?.startsWith("vm0_org_")) {
    return {
      ok: false,
      error: {
        message: "Organization access token required",
        code: "FORBIDDEN",
        status: 403,
      },
    };
  }

  const orgAuth = await resolveOrgAccessToken(token);
  if (!orgAuth) {
    return {
      ok: false,
      error: {
        message: "Invalid or expired org token",
        code: "UNAUTHORIZED",
        status: 401,
      },
    };
  }

  return { ok: true, auth: orgAuth };
}
