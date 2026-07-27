import { command } from "ccstate";
import { artifactCatalogContract } from "@vm0/api-contracts/contracts/artifact-catalog";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import {
  getArtifactCatalogEntry$,
  listArtifactCatalog$,
} from "../services/artifact-catalog.service";
import type { RouteEntry } from "../route-entry";

const listArtifactCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactCatalogContract.list));
    const result = await set(
      listArtifactCatalog$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        limit: query.limit,
        cursor: query.cursor,
        kind: query.kind,
        chatThreadId: query.chatThreadId,
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
