import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroUsageMembersContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { getUsageMembers } from "../../../../../src/lib/billing/usage-service";

const router = tsr.router(zeroUsageMembersContract, {
  get: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    const response = await getUsageMembers(org.orgId);

    return { status: 200 as const, body: response };
  },
});

const handler = createHandler(zeroUsageMembersContract, router, {
  errorHandler: createSafeErrorHandler("zero-usage-members"),
});

export { handler as GET };
