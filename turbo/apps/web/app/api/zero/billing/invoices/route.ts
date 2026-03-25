import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingInvoicesContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { getOrgInvoices } from "../../../../../src/lib/billing/billing-service";

const router = tsr.router(zeroBillingInvoicesContract, {
  get: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    const result = await getOrgInvoices(org.orgId);

    return {
      status: 200 as const,
      body: result,
    };
  },
});

const handler = createHandler(zeroBillingInvoicesContract, router, {
  errorHandler: createSafeErrorHandler("zero-billing-invoices"),
});

export { handler as GET };
