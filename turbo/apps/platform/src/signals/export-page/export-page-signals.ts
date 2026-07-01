import { command, computed, state } from "ccstate";
import {
  userExportContract,
  type UserExportStatusResponse,
} from "@vm0/api-contracts/contracts/user-export";
import { zeroClient$ } from "../api-client.ts";
import { setLoop } from "../utils.ts";

const POLL_INTERVAL_MS = 5000;

const statusReload$ = state(0);
const exportStartError$ = state<string | null>(null);

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}

function isStatusInProgress(status: UserExportStatusResponse): boolean {
  return status.job?.status === "pending" || status.job?.status === "running";
}

export const userExportStartError$ = computed((get) => {
  return get(exportStartError$);
});

export const userExportStatus$ = computed(
  async (get): Promise<UserExportStatusResponse> => {
    get(statusReload$);
    const client = get(zeroClient$)(userExportContract);
    const result = await client.get();
    if (result.status !== 200) {
      throw new Error(
        errorMessageFromBody(result.body, "Failed to load export"),
      );
    }
    return result.body;
  },
);

export const reloadUserExportStatus$ = command(({ set }) => {
  set(statusReload$, (value) => {
    return value + 1;
  });
});

export const watchUserExportStatus$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await setLoop(
      async (loopSignal) => {
        set(reloadUserExportStatus$);
        const status = await get(userExportStatus$);
        loopSignal.throwIfAborted();
        return !isStatusInProgress(status);
      },
      POLL_INTERVAL_MS,
      signal,
    );
  },
);

export const startUserExport$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(exportStartError$, null);

    const client = get(zeroClient$)(userExportContract);
    const result = await client.post({
      body: undefined,
      fetchOptions: { signal },
    });
    signal.throwIfAborted();

    if (result.status === 202) {
      set(reloadUserExportStatus$);
      await set(watchUserExportStatus$, signal);
      return;
    }

    if (result.status === 429) {
      set(exportStartError$, "You can export once every 24 hours.");
      set(reloadUserExportStatus$);
      return;
    }

    set(
      exportStartError$,
      errorMessageFromBody(result.body, "Failed to start export"),
    );
  },
);
