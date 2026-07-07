import { command } from "ccstate";
import {
  artifactsContract,
  type ArtifactItem,
  type ChatThreadArtifactGoogleDriveSync,
  type ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup,
} from "../services/google-drive-artifact-sync.service";
import {
  decodeArtifactListCursor,
  zeroArtifacts$,
} from "../services/zero-chat-thread.service";
import type { RouteEntry } from "../route-entry";

function artifactSyncKey(runId: string, fileId: string): string {
  return `${runId}:${fileId}`;
}

function artifactRunsForSync(
  artifacts: readonly ArtifactItem[],
): ChatThreadArtifactRun[] {
  const byRun = new Map<string, ChatThreadArtifactRun>();
  for (const artifact of artifacts) {
    const run = byRun.get(artifact.runId) ?? {
      runId: artifact.runId,
      files: [],
    };
    run.files.push({
      id: artifact.fileId,
      filename: artifact.filename,
      contentType: artifact.contentType,
      size: artifact.size,
      url: artifact.url,
      createdAt: artifact.createdAt,
      ...(artifact.artifactKind ? { artifactKind: artifact.artifactKind } : {}),
    });
    byRun.set(artifact.runId, run);
  }
  return [...byRun.values()];
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
        const runs = applyGoogleDriveArtifactSyncStatuses(
          artifactRunsForSync(artifacts),
          lookup,
        );
        for (const run of runs) {
          for (const file of run.files) {
            if (file.googleDriveSync) {
              syncByArtifact.set(
                artifactSyncKey(run.runId, file.id),
                file.googleDriveSync,
              );
            }
          }
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
