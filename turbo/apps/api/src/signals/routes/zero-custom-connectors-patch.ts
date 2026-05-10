import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { notFound } from "../../lib/error";
import {
  validateDisplayName,
  type CustomConnectorRow,
} from "../services/zero-custom-connector.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can rename custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

function isBadRequestResponse(
  value: unknown,
): value is { readonly status: 400; readonly body: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === 400
  );
}

function serialiseRow(row: CustomConnectorRow) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    prefixes: [...row.prefixes],
    headerName: row.headerName,
    headerTemplate: row.headerTemplate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasSecret: false,
  };
}

const patchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const params = get(pathParamsOf(zeroCustomConnectorByIdContract.patch));
  const bodyResult = await get(
    bodyResultOf(zeroCustomConnectorByIdContract.patch),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const displayName = validateDisplayName(bodyResult.data.displayName);
  if (isBadRequestResponse(displayName)) {
    return displayName;
  }

  const writeDb = set(writeDb$);
  const [row] = await writeDb
    .update(orgCustomConnectors)
    .set({ displayName, updatedAt: nowDate() })
    .where(
      and(
        eq(orgCustomConnectors.id, params.id),
        eq(orgCustomConnectors.orgId, auth.orgId),
      ),
    )
    .returning();
  signal.throwIfAborted();

  if (!row) {
    return notFound("Custom connector not found");
  }

  return {
    status: 200 as const,
    body: serialiseRow({
      ...row,
      prefixes: row.prefixes as readonly string[],
    }),
  };
});

export const zeroCustomConnectorsPatchRoutes: readonly RouteEntry[] = [
  {
    route: zeroCustomConnectorByIdContract.patch,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      patchInner$,
    ),
  },
];
