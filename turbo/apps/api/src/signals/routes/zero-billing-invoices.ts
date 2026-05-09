import { computed } from "ccstate";
import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroOrgInvoices } from "../services/zero-billing-invoices.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can view invoices",
      code: "FORBIDDEN",
    }),
  }),
});

const getInvoicesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  const invoices = await get(zeroOrgInvoices(auth.orgId));
  return { status: 200 as const, body: invoices };
});

export const zeroBillingInvoicesRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingInvoicesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getInvoicesInner$,
    ),
  },
];
