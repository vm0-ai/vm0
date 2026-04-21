import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { cliAuthOrgContract } from "@vm0/core";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { getOrgIdBySlug } from "../../../../../src/lib/auth/org-cache";
import { getMemberRole } from "../../../../../src/lib/auth/org-membership-cache";
import { generateCliToken } from "../../../../../src/lib/auth/sandbox-token";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";

/**
 * Switch active organization and get a new CLI JWT.
 *
 * Requires Bearer token authentication (CLI JWT).
 * Validates that the user is a member of the target organization.
 */
const router = tsr.router(cliAuthOrgContract, {
  switchOrg: async ({ body, headers }) => {
    initServices();

    // 1. Authenticate
    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Authentication required", code: "unauthorized" },
        },
      };
    }

    // 2. Resolve org by slug (body.slug is validated by contract — non-empty string)
    const orgId = await getOrgIdBySlug(body.slug);
    if (!orgId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Organization not found", code: "not_found" },
        },
      };
    }

    // 3. Verify membership
    const membership = await getMemberRole(orgId, authCtx.userId);
    if (!membership) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Not a member of this organization",
            code: "forbidden",
          },
        },
      };
    }

    // 4. Generate new CLI JWT with target org
    const tokenId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days
    const cliToken = await generateCliToken(authCtx.userId, orgId, tokenId);

    await globalThis.services.db.insert(cliTokens).values({
      id: tokenId,
      token: cliToken,
      userId: authCtx.userId,
      name: "CLI Org Switch",
      expiresAt,
      createdAt: now,
    });

    return {
      status: 200 as const,
      body: {
        access_token: cliToken,
        token_type: "Bearer" as const,
        expires_in: 90 * 24 * 60 * 60,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to OAuth error format.
 * Matches the contract's 400 response schema (oauthErrorSchema).
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          {
            error: "invalid_request",
            error_description: `${issue.path.join(".")}: ${issue.message}`,
          },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(cliAuthOrgContract, router, {
  routeName: "cli.auth.org",
  errorHandler,
});

export { handler as POST };
