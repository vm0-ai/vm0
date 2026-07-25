import { command } from "ccstate";
import { artifactCatalogContract } from "@vm0/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import {
  getArtifactCatalogEntry$,
  listArtifactCatalog$,
} from "../services/artifact-catalog.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

function catalogDisabled() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Artifact catalog is not available",
        code: "FORBIDDEN" as const,
      },
    },
  };
}

/**
 * The catalog is only reachable from the Artifacts page, which the `Artifacts`
 * switch already gates per org. Reusing that switch keeps the page and its API
 * from drifting apart during rollout.
 */
const artifactCatalogEnabled$ = command(
  async (
    { get },
    auth: { readonly orgId: string; readonly userId: string },
  ): Promise<boolean> => {
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    return isFeatureEnabled(FeatureSwitchKey.Artifacts, {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    });
  },
);

const listArtifactCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(artifactCatalogEnabled$, auth))) {
      return catalogDisabled();
    }
    signal.throwIfAborted();

    const query = get(queryOf(artifactCatalogContract.list));
    const result = await set(
      listArtifactCatalog$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        limit: query.limit,
        cursor: query.cursor,
        kind: query.kind,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        artifacts: [...result.artifacts],
        nextCursor: result.nextCursor,
      },
    };
  },
);

const getArtifactCatalogEntryInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(artifactCatalogEnabled$, auth))) {
      return catalogDisabled();
    }
    signal.throwIfAborted();

    const params = get(pathParamsOf(artifactCatalogContract.get));
    const artifact = await set(
      getArtifactCatalogEntry$,
      {
        artifactId: params.artifactId,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact not found");
    }

    return { status: 200 as const, body: artifact };
  },
);

export const zeroArtifactCatalogRoutes: readonly RouteEntry[] = [
  {
    route: artifactCatalogContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      listArtifactCatalogInner$,
    ),
  },
  {
    route: artifactCatalogContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      getArtifactCatalogEntryInner$,
    ),
  },
];
