import { command } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroUserConnectorsContract,
  type UserConnectorEnabledTypes,
} from "@vm0/api-contracts/contracts/user-connectors";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { connectors$, reloadConnectors$ } from "../external/connectors.ts";
import { setAblyLoop$ } from "../realtime.ts";

type ArtifactGoogleDriveSyncParams = {
  readonly agentId?: string;
  readonly threadId: string;
} & ArtifactGoogleDriveSyncFile;

export type ArtifactGoogleDriveSyncFile = {
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

export async function syncArtifactFilesToGoogleDrive(
  params: ArtifactGoogleDriveSyncFilesParams & {
    readonly createClient: ZeroClientFactory;
    readonly signal?: AbortSignal;
  },
): Promise<boolean> {
  if (params.files.length === 0) {
    toast.error("No artifacts to sync");
    return false;
  }

  const toastId = toast.loading(googleDriveSyncLoadingMessage(params.files));
  const client = params.createClient(chatThreadArtifactsContract);
  const results: ArtifactGoogleDriveSyncResult[] = [];
  for (const file of params.files) {
    params.signal?.throwIfAborted();
    const result = await accept(
      client.syncGoogleDrive({
        params: { threadId: params.threadId },
        body: {
          runId: file.runId,
          fileId: file.fileId,
        },
        fetchOptions: params.signal ? { signal: params.signal } : undefined,
      }),
      [200],
      { toast: false },
    ).then(
      () => {
        return { ok: true as const };
      },
      (error: unknown) => {
        params.signal?.throwIfAborted();
        return {
          ok: false as const,
          message: googleDriveSyncErrorMessage(error),
        };
      },
    );
    results.push(result);
  }
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
  const current = (await accept(
    client.get({
      params: { id: params.agentId },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  )) as { body: UserConnectorEnabledTypes };
  params.signal.throwIfAborted();

  if (current.body.enabledTypes.includes("google-drive")) {
    return;
  }

  await accept(
    client.update({
      params: { id: params.agentId },
      body: { enabledTypes: [...current.body.enabledTypes, "google-drive"] },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  params.signal.throwIfAborted();
}

export const waitForGoogleDriveAndSyncArtifacts$ = command(
  async (
    { set },
    params: ArtifactGoogleDriveSyncFilesParams & { readonly agentId: string },
    signal: AbortSignal,
  ) => {
    const syncWhenConnected$ = command(
      async ({ get, set }, sig: AbortSignal) => {
        set(reloadConnectors$);
        const { connectors } = await get(connectors$);
        sig.throwIfAborted();
        const connected = connectors.some((connector) => {
          return connector.type === "google-drive" && !connector.needsReconnect;
        });
        if (!connected) {
          return false;
        }

        const createClient = get(zeroClient$);
        await authorizeGoogleDriveForAgent({
          agentId: params.agentId,
          createClient,
          signal: sig,
        });
        sig.throwIfAborted();

        await syncArtifactFilesToGoogleDrive({
          createClient,
          threadId: params.threadId,
          files: params.files,
          signal: sig,
        });
        return true;
      },
    );

    if (await set(syncWhenConnected$, signal)) {
      return;
    }
    signal.throwIfAborted();
    await set(setAblyLoop$, "connector:changed", syncWhenConnected$, signal);
  },
);
