import { computed } from "ccstate";
import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
import { zeroOrgInvoices } from "../services/zero-billing-invoices.service";
import type { RouteEntry } from "../route";
const getInvoicesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const invoices = await get(zeroOrgInvoices(auth.orgId));
  return { status: 200 as const, body: invoices };
});

export const zeroBillingInvoicesRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingInvoicesContract.get,
    handler: shadowCompareRoute({
      route: zeroBillingInvoicesContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getInvoicesInner$,
      ),
    }),
  },
];
