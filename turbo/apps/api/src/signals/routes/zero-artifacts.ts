import { command } from "ccstate";
import { artifactsContract } from "@vm0/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import {
  favoriteArtifact$,
  unfavoriteArtifact$,
  zeroArtifacts$,
} from "../services/zero-chat-thread.service";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const listArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactsContract.list));

    const result = await set(
      zeroArtifacts$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        limit: query.limit,
        cursor: query.cursor,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        artifacts: result.artifacts,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
      },
    };
  },
);

const favoriteArtifactInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(bodyResultOf(artifactsContract.favorite));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const visible = await set(
      favoriteArtifact$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        artifactUrl: bodyResult.data.artifactUrl,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!visible) {
      return notFound("Artifact not found");
    }

    return { status: 204 as const, body: undefined };
  },
);

const unfavoriteArtifactInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(bodyResultOf(artifactsContract.unfavorite));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    await set(
      unfavoriteArtifact$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        artifactUrl: bodyResult.data.artifactUrl,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroArtifactsRoutes: readonly RouteEntry[] = [
  {
    route: artifactsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      listArtifactsInner$,
    ),
  },
  {
    route: artifactsContract.favorite,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      favoriteArtifactInner$,
    ),
  },
  {
    route: artifactsContract.unfavorite,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-message:read",
      },
      unfavoriteArtifactInner$,
    ),
  },
];
