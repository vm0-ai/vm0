import { computed } from "ccstate";
import { zeroRelationshipsContract } from "@vm0/api-contracts/contracts/zero-relationships";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$, type ReadonlyDb } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  zeroRelationshipResolve,
  zeroRelationshipSearch,
} from "../services/zero-relationships.service";

const relationshipReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "relationship:read",
} as const;

const relationshipMemoryDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Relationship memory is not enabled for this organization.",
      code: "FORBIDDEN",
    }),
  }),
});

async function isRelationshipMemoryEnabled(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return isFeatureEnabled(FeatureSwitchKey.RelationshipMemory, context);
}

const resolveQuery$ = queryOf(zeroRelationshipsContract.resolve);
const searchQuery$ = queryOf(zeroRelationshipsContract.search);

const resolveInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await isRelationshipMemoryEnabled(get(db$), auth.orgId, auth.userId))) {
    return relationshipMemoryDisabled;
  }

  const query = get(resolveQuery$);
  const result = await get(
    zeroRelationshipResolve({
      orgId: auth.orgId,
      userId: auth.userId,
      id: query.id,
      email: query.email,
      domain: query.domain,
    }),
  );
  return { status: 200 as const, body: result };
});

const searchInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!(await isRelationshipMemoryEnabled(get(db$), auth.orgId, auth.userId))) {
    return relationshipMemoryDisabled;
  }

  const query = get(searchQuery$);
  const result = await get(
    zeroRelationshipSearch({
      orgId: auth.orgId,
      userId: auth.userId,
      q: query.q,
      limit: query.limit,
    }),
  );
  return { status: 200 as const, body: result };
});

export const zeroRelationshipsRoutes: readonly RouteEntry[] = [
  {
    route: zeroRelationshipsContract.resolve,
    handler: authRoute(relationshipReadAuth, resolveInner$),
  },
  {
    route: zeroRelationshipsContract.search,
    handler: authRoute(relationshipReadAuth, searchInner$),
  },
];
