import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { orgContract } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { createScope, isVm0Admin } from "../../../src/lib/scope/scope-service";
import { getUserEmail } from "../../../src/lib/auth/get-user-email";
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
      // vm0-admin slug policy: allow vm0-prefixed slugs for admin users only
      let skipSlugValidation = false;
      if (body.slug.startsWith("vm0")) {
        const email = await getUserEmail(userId);
        if (!isVm0Admin(email)) {
          return {
            status: 400 as const,
            body: {
              error: {
                message: `Scope slug "${body.slug}" is reserved`,
                code: "BAD_REQUEST",
              },
            },
          };
        }
        skipSlugValidation = true;
      }

      const scope = await createScope(userId, body.slug, {
        skipSlugValidation,
      });

      return {
        status: 201 as const,
        body: {
          slug: scope.slug,
          role: "admin" as const,
          members: [
            {
              userId,
              email: "",
              role: "admin" as const,
              joinedAt: scope.createdAt.toISOString(),
            },
          ],
          createdAt: scope.createdAt.toISOString(),
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
        log.error("Failed to create scope (Clerk API)", {
          status: error.status,
          errors: error.errors,
          clerkTraceId: error.clerkTraceId,
        });
      } else {
        log.error("Failed to create scope", { error: message });
      }
      return {
        status: 500 as const,
        body: {
          error: { message, code: "INTERNAL_ERROR" },
        },
      };
    }
  },
});

const handler = createHandler(orgContract, router);

export { handler as POST };
