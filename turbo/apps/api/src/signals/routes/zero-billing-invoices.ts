import { command, computed } from "ccstate";
import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import {
  downloadZeroOrgReceiptArchive$,
  zeroOrgInvoices,
} from "../services/zero-billing-invoices.service";
import type { RouteEntry } from "../route-entry";

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

const downloadReceiptsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const query = get(queryOf(zeroBillingInvoicesContract.downloadReceipts));
    const result = await set(
      downloadZeroOrgReceiptArchive$,
      {
        orgId: auth.orgId,
        startMonth: query.startMonth,
        endMonth: query.endMonth,
      },
      signal,
    );
    if (result.kind === "not_found") {
      return Response.json(
        {
          error: {
            message: "No receipts are available for the selected month",
            code: "NOT_FOUND",
          },
        },
        { status: 404 },
      );
    }
    if (result.kind === "upstream_error") {
      return Response.json(
        {
          error: {
            message: "Failed to download receipts from Stripe",
            code: "BAD_GATEWAY",
          },
        },
        { status: 502 },
      );
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/zip");
    headers.set("Content-Length", String(result.archive.content.byteLength));
    headers.set(
      "Content-Disposition",
      `attachment; filename="${result.archive.filename}"`,
    );
    const body = new Uint8Array(result.archive.content.byteLength);
    body.set(result.archive.content);
    return new Response(body, { status: 200, headers });
  },
);

export const zeroBillingInvoicesRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingInvoicesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getInvoicesInner$,
    ),
  },
  {
    route: zeroBillingInvoicesContract.downloadReceipts,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      downloadReceiptsInner$,
    ),
  },
];
