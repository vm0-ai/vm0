import { command, computed, state } from "ccstate";
import {
  userExportContract,
  type UserExportStatusResponse,
} from "@vm0/api-contracts/contracts/user-export";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { onRef, setLoop } from "../utils.ts";

const POLL_INTERVAL_MS = 5000;

const statusReload$ = state(0);
const exportStartError$ = state<string | null>(null);

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
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);

const reloadUserExportStatus$ = command(({ set }) => {
  set(statusReload$, (value) => {
    return value + 1;
  });
});

const watchUserExportStatus$ = command(
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
    const result = await accept(
      client.post({
        body: undefined,
        fetchOptions: { signal },
      }),
      [202, 429],
      { toast: false },
    );
    signal.throwIfAborted();

    if (result.status === 202) {
      set(reloadUserExportStatus$);
      return;
    }

    set(exportStartError$, "You can export once every 24 hours.");
    set(reloadUserExportStatus$);
  },
);

export const userExportStatusPollingRef$ = onRef(
  command(async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    await set(watchUserExportStatus$, signal);
  }),
);
