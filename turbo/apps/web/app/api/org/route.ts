import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { orgContract } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { createOrganization } from "../../../src/lib/org/org-service";
import { isBadRequest } from "../../../src/lib/errors";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { logger } from "../../../src/lib/logger";

const log = logger("api:org");

const router = tsr.router(orgContract, {
  create: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    try {
      const result = await createOrganization(userId, body.slug);

      return {
        status: 201 as const,
        body: {
          slug: result.scope.slug,
          role: result.role,
          members: [
            {
              userId,
              email: "",
              role: "admin" as const,
              joinedAt: result.scope.createdAt.toISOString(),
            },
          ],
          createdAt: result.scope.createdAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: error.message, code: "BAD_REQUEST" },
          },
        };
      }
      const message =
        error instanceof Error ? error.message : "Internal server error";
      if (isClerkAPIResponseError(error)) {
        log.error("Failed to create organization (Clerk API)", {
          status: error.status,
          errors: error.errors,
          clerkTraceId: error.clerkTraceId,
        });
      } else {
        log.error("Failed to create organization", { error: message });
      }
      return {
        status: 500 as const,
        body: {
          error: { message, code: "INTERNAL_ERROR" },
        },
      };
    }
  },

  // Stub handlers required by ts-rest contract router. The actual implementations
  // live in separate Next.js route files (e.g., /api/org/status/route.ts) which
  // take precedence over these stubs due to Next.js file-system routing.
  status: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/status", code: "NOT_FOUND" },
    },
  }),

  leave: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/leave", code: "NOT_FOUND" },
    },
  }),

  invite: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/invite", code: "NOT_FOUND" },
    },
  }),

  removeMember: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/members", code: "NOT_FOUND" },
    },
  }),
});

const handler = createHandler(orgContract, router);

export { handler as POST };
