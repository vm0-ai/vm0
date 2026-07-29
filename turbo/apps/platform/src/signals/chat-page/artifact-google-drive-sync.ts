import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { isConnectorChangedPayloadFor } from "../connector-change.ts";
import { connectors$, reloadConnectors$ } from "../external/connectors.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import {
  isAgentConnectorAuthorized,
  reloadAgentConnectorAuthorizations$,
} from "../zero-page/agent-connector-authorizations.ts";
import { settle, withCleanup } from "../utils.ts";

type ArtifactGoogleDriveSyncParams = {
  readonly agentId?: string;
  readonly threadId: string;
} & ArtifactGoogleDriveSyncFile;

type ArtifactGoogleDriveSyncFile = {
  readonly runId: string;
  readonly fileId: string;
  readonly filename?: string | undefined;
};

type ArtifactGoogleDriveSyncFilesParams = {
  readonly agentId?: string;
  readonly threadId: string;
  readonly files: readonly ArtifactGoogleDriveSyncFile[];
};

function googleDriveSyncErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Failed to sync to Google Drive";
}

function googleDriveSyncLoadingMessage(
  files: readonly ArtifactGoogleDriveSyncFile[],
): string {
  if (files.length === 1) {
    const filename = files[0]?.filename;
    return filename ? `Syncing ${filename}...` : "Syncing artifact...";
  }
  return `Syncing ${files.length} files...`;
}

function googleDriveSyncSuccessMessage(fileCount: number): string {
  return fileCount === 1
    ? "Synced to Google Drive"
    : `Synced ${fileCount} files to Google Drive`;
}

type ArtifactGoogleDriveSyncResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

function isArtifactGoogleDriveSyncFailure(
  result: ArtifactGoogleDriveSyncResult,
): result is Extract<ArtifactGoogleDriveSyncResult, { readonly ok: false }> {
  return !result.ok;
}

async function syncArtifactFilesToGoogleDrive(
  params: ArtifactGoogleDriveSyncFilesParams & {
    readonly createClient: ZeroClientFactory;
    readonly signal?: AbortSignal;
  },
): Promise<boolean> {
  params.signal?.throwIfAborted();
  if (params.files.length === 0) {
    toast.error("No artifacts to sync");
    return false;
  }

  const toastId = toast.loading(googleDriveSyncLoadingMessage(params.files));
  const sync = async (): Promise<boolean> => {
    const client = params.createClient(chatThreadArtifactsContract);
    const results: ArtifactGoogleDriveSyncResult[] = [];
    for (const file of params.files) {
      params.signal?.throwIfAborted();
      const settled = await settle(
        accept(
          client.syncGoogleDrive({
            params: { threadId: params.threadId },
            body: {
              runId: file.runId,
              fileId: file.fileId,
            },
            fetchOptions: params.signal ? { signal: params.signal } : undefined,
          }),
          [200, 400, 401, 403, 404, 503],
        ),
        params.signal,
      );
      const result: ArtifactGoogleDriveSyncResult = settled.ok
        ? settled.value.status === 200
          ? { ok: true }
          : { ok: false, message: settled.value.body.error.message }
        : {
            ok: false,
            message: googleDriveSyncErrorMessage(settled.error),
          };
      results.push(result);
    }
    params.signal?.throwIfAborted();
    const syncedCount = results.filter((result) => {
      return result.ok;
    }).length;

    if (syncedCount === params.files.length) {
      toast.success(googleDriveSyncSuccessMessage(params.files.length), {
        id: toastId,
      });
      return true;
    }

    const firstFailure = results.find(isArtifactGoogleDriveSyncFailure);
    toast.error(
      syncedCount > 0
        ? `Synced ${syncedCount} of ${params.files.length} files to Google Drive`
        : (firstFailure?.message ?? "Failed to sync to Google Drive"),
      { id: toastId },
    );
    return syncedCount > 0;
  };

  return await withCleanup(sync(), () => {
    if (params.signal?.aborted) {
      toast.dismiss(toastId);
    }
  });
}

export async function syncArtifactFileToGoogleDrive(
  params: ArtifactGoogleDriveSyncParams & {
    readonly createClient: ZeroClientFactory;
    readonly signal?: AbortSignal;
  },
): Promise<boolean> {
  return await syncArtifactFilesToGoogleDrive({
    createClient: params.createClient,
    threadId: params.threadId,
    files: [
      {
        runId: params.runId,
        fileId: params.fileId,
        filename: params.filename,
      },
    ],
    signal: params.signal,
  });
}

async function authorizeGoogleDriveForAgent(params: {
  readonly agentId: string;
  readonly createClient: ZeroClientFactory;
  readonly signal: AbortSignal;
}): Promise<void> {
  const client = params.createClient(zeroUserConnectorsContract);
  await accept(
    client.update({
      params: { id: params.agentId },
      body: { enabledTypes: ["google-drive"], operation: "add" },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  params.signal.throwIfAborted();
}

export const waitForGoogleDriveAuthorization$ = command(
  async (
    { get, set },
    params: {
      readonly agentId: string;
      readonly authorizeConnected?: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (params.authorizeConnected) {
      await authorizeGoogleDriveForAgent({
        agentId: params.agentId,
        createClient: get(zeroClient$),
        signal,
      });
    }

    const authorizationReady$ = command(
      async ({ get, set }, sig: AbortSignal): Promise<boolean> => {
        set(reloadConnectors$);
        set(reloadAgentConnectorAuthorizations$);
        const [{ connectors }, authorized] = await Promise.all([
          get(connectors$),
          get(
            isAgentConnectorAuthorized({
              agentId: params.agentId,
              connectorSlug: "google-drive",
            }),
          ),
        ]);
        sig.throwIfAborted();
        const connected = connectors.some((connector) => {
          return (
            connector.type === "google-drive" &&
            connector.connectionStatus === "connected"
          );
        });
        return connected && authorized;
      },
    );

    if (await set(authorizationReady$, signal)) {
      return;
    }
    signal.throwIfAborted();
    const matchingConnectorChanged$ = command(
      async ({ set }, payload: unknown, sig: AbortSignal): Promise<boolean> => {
        if (!isConnectorChangedPayloadFor(payload, "google-drive")) {
          return false;
        }
        return await set(authorizationReady$, sig);
      },
    );
    await set(
      setAblyPayloadLoop$,
      {
        topic: "connector:changed",
        loopCommand$: matchingConnectorChanged$,
        catchUpCommand$: authorizationReady$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
