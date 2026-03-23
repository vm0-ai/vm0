import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroOrgContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { updateOrg } from "../../../../src/lib/org/org-service";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "../../../../src/lib/errors";

const router = tsr.router(zeroOrgContract, {
  get: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");

    try {
      const { org: resolvedOrg, member } = await resolveOrg(authCtx, orgSlug);

      return {
        status: 200 as const,
        body: {
          id: resolvedOrg.orgId,
          slug: resolvedOrg.slug,
          name: resolvedOrg.name,
          tier: resolvedOrg.tier,
          role: member.role,
        },
      };
    } catch (error) {
      if (isNotFound(error) || isBadRequest(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Resource not found", code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },

  update: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");

    let resolvedOrg;
    try {
      ({ org: resolvedOrg } = await resolveOrg(authCtx, orgSlug));
    } catch (error) {
      if (isNotFound(error) || isBadRequest(error)) {
        return {
          status: 404 as const,
          body: {
            error: {
              message:
                "No org configured. Set your org with: vm0 org set <slug>",
              code: "NOT_FOUND",
            },
          },
        };
      }
      throw error;
    }

    try {
      const updatedOrg = await updateOrg(resolvedOrg.orgId, userId, {
        slug: body.slug,
        name: body.name,
        force: body.force,
      });

      return {
        status: 200 as const,
        body: {
          id: updatedOrg.orgId,
          slug: updatedOrg.slug,
          name: updatedOrg.name,
          tier: updatedOrg.tier,
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        if (error.message.includes("already exists")) {
          return {
            status: 409 as const,
            body: {
              error: { message: "Resource conflict", code: "CONFLICT" },
            },
          };
        }
        return {
          status: 400 as const,
          body: {
            error: { message: "Invalid request", code: "BAD_REQUEST" },
          },
        };
      }
      if (isForbidden(error)) {
        return {
          status: 403 as const,
          body: {
            error: { message: "Access denied", code: "FORBIDDEN" },
          },
        };
      }
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Resource not found", code: "NOT_FOUND" },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroOrgContract, router, {
  errorHandler: createSafeErrorHandler("zero-org"),
});

export { handler as GET, handler as PUT };
