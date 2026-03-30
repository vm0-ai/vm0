import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgDomainsContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import {
  getOrgDomains,
  addOrgDomain,
  removeOrgDomain,
  setOrgDomainVerified,
} from "../../../../../src/lib/org/org-member-service";
import { isForbidden } from "../../../../../src/lib/errors";

const router = tsr.router(zeroOrgDomainsContract, {
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      const result = await getOrgDomains(org.orgId, member.role);
      return { status: 200 as const, body: result };
    } catch (error) {
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      throw error;
    }
  },

  add: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await addOrgDomain(
        org.orgId,
        member.role,
        body.name,
        body.enrollmentMode,
      );
      return {
        status: 200 as const,
        body: { message: `Domain ${body.name} added` },
      };
    } catch (error) {
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      throw error;
    }
  },

  remove: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await removeOrgDomain(org.orgId, member.role, body.domainId);
      return {
        status: 200 as const,
        body: { message: "Domain removed" },
      };
    } catch (error) {
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      throw error;
    }
  },
  setVerified: async ({ headers, body }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    try {
      const orgSlug = new URL(request.url).searchParams.get("org");
      const { org, member } = await resolveOrg(authCtx, orgSlug);
      await setOrgDomainVerified(
        org.orgId,
        member.role,
        body.domainId,
        body.verified,
      );
      return {
        status: 200 as const,
        body: {
          message: body.verified ? "Domain verified" : "Domain unverified",
        },
      };
    } catch (error) {
      if (isForbidden(error)) {
        return createErrorResponse("FORBIDDEN", "Access denied");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroOrgDomainsContract, router, {
  errorHandler: createSafeErrorHandler("zero-org-domains"),
});

export { handler as GET, handler as POST, handler as DELETE, handler as PATCH };
