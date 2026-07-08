import { command } from "ccstate";
import {
  artifactsContract,
  type ArtifactItem,
  type ChatThreadArtifactGoogleDriveSync,
} from "@vm0/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import {
  googleDriveArtifactStatusLookup,
  resolveGoogleDriveArtifactSyncStatus,
} from "../services/google-drive-artifact-sync.service";
import {
  decodeArtifactListCursor,
  zeroArtifacts$,
} from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route-entry";

function artifactSyncKey(runId: string, fileId: string): string {
  return `${runId}:${fileId}`;
}

const listArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactsContract.list));
    const decodedCursor = decodeArtifactListCursor(query.cursor);
    if (!decodedCursor.ok) {
      return badRequestMessage("Invalid artifacts cursor");
    }

    const page = await set(
      zeroArtifacts$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        agentId: query.agentId,
        query: query.query,
        artifactKind: query.artifactKind,
        cursor: decodedCursor.cursor,
        limit: query.limit,
      },
      signal,
    );
    signal.throwIfAborted();

    const artifactsByThread = new Map<string, ArtifactItem[]>();
    for (const artifact of page.artifacts) {
      const threadArtifacts = artifactsByThread.get(artifact.threadId) ?? [];
      threadArtifacts.push(artifact);
      artifactsByThread.set(artifact.threadId, threadArtifacts);
    }

    const syncByArtifact = new Map<string, ChatThreadArtifactGoogleDriveSync>();
    await Promise.all(
      [...artifactsByThread.entries()].map(async ([threadId, artifacts]) => {
        const lookup = await get(
          googleDriveArtifactStatusLookup({
            threadId,
            orgId: auth.orgId,
            userId: auth.userId,
          }),
        );
        signal.throwIfAborted();
        for (const artifact of artifacts) {
          syncByArtifact.set(
            artifactSyncKey(artifact.runId, artifact.fileId),
            resolveGoogleDriveArtifactSyncStatus(
              lookup,
              artifact.runId,
              artifact.fileId,
            ),
          );
        }
      }),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        artifacts: page.artifacts.map((artifact) => {
          const googleDriveSync = syncByArtifact.get(
            artifactSyncKey(artifact.runId, artifact.fileId),
          );
          return googleDriveSync ? { ...artifact, googleDriveSync } : artifact;
        }),
        nextCursor: page.nextCursor,
      },
    };
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
];
