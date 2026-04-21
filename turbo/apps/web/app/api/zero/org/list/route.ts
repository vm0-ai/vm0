import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroOrgListContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { getUserAccessibleOrgs } from "../../../../../src/lib/zero/org/org-member-service";

const router = tsr.router(zeroOrgListContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgs = await getUserAccessibleOrgs(authCtx.userId);

    return {
      status: 200 as const,
      body: { orgs, active: undefined },
    };
  },
});

const handler = createHandler(zeroOrgListContract, router, {
  routeName: "zero.org.list",
});

export { handler as GET };
