import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { getOrgInvoices } from "../../../../../src/lib/zero/billing/billing-service";

const router = tsr.router(zeroBillingInvoicesContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);
    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only org admins can view invoices",
      );
    }

    const result = await getOrgInvoices(org.orgId);

    return {
      status: 200 as const,
      body: result,
    };
  },
});

const handler = createHandler(zeroBillingInvoicesContract, router, {
  routeName: "zero.billing.invoices",
});

export { handler as GET };
