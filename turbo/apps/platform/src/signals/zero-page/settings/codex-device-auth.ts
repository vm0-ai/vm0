import { command, computed, state, type Command, type State } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroCodexDeviceAuthContract,
  type CodexDeviceAuthScope,
} from "@vm0/api-contracts/contracts/zero-codex-device-auth";

import { ApiError, accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import { zeroClient$ } from "../../api-client.ts";
import { reloadOrgModelProviders$ } from "../../external/org-model-providers.ts";
import { reloadPersonalModelProviders$ } from "../../external/personal-model-providers.ts";
import { onRef, resetSignal, settle, setLoop } from "../../utils.ts";
import { writeToClipboard } from "../clipboard.ts";

type CodexDeviceAuthDialogMode = "connect" | "reconnect";

interface CodexDeviceAuthDialogState {
  open: boolean;
  mode: CodexDeviceAuthDialogMode;
}

type ActiveCodexDeviceAuthFlowState = {
  readonly status: "pending" | "polling";
  readonly requestId: string;
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly verificationCode: string;
  readonly expiresAtMs: number;
  readonly pollIntervalMs: number;
  readonly approvalOpened: boolean;
  readonly codeCopied: boolean;
  readonly errorMessage: string | null;
};

type CodexDeviceAuthFlowState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly requestId: string }
  | ActiveCodexDeviceAuthFlowState
  | { readonly status: "expired"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const CODEX_DEVICE_AUTH_MIN_POLL_MS = 1000;

function createInitialDialogState(): CodexDeviceAuthDialogState {
  return {
    open: false,
    mode: "connect",
  };
}

function createIdleFlowState(): CodexDeviceAuthFlowState {
  return { status: "idle" };
}

function createRequestId(scope: CodexDeviceAuthScope): string {
  return `${scope}-codex-device-auth-${now()}-${Math.random().toString(36).slice(2)}`;
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function codexDeviceAuthErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "CODEX_AUTH_JSON_SHAPE_INVALID") {
      return "Codex produced a login token format vm0 does not recognize. Update Codex and try again.";
    }
    if (error.code === "CODEX_FREE_PLAN_REJECTED") {
      return "Free ChatGPT plans cannot use Codex via vm0. Upgrade to Plus or Pro and try again.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Codex connection failed";
}

function openApprovalPage(browserUrl: string): boolean {
  const approvalWindow = window.open(browserUrl, "_blank");
  if (!approvalWindow) {
    return false;
  }
  approvalWindow.opener = null;
  return true;
}

async function copyCodeAndOpenApprovalPage(
  current: ActiveCodexDeviceAuthFlowState,
): Promise<{ readonly opened: boolean; readonly copied: boolean }> {
  const copyPromise = writeToClipboard(current.verificationCode);
  const opened = openApprovalPage(current.browserUrl);
  const copied = await copyPromise;
  return { opened, copied };
}

function approvalAttemptErrorMessage(args: {
  readonly opened: boolean;
  readonly copied: boolean;
}): string | null {
  if (args.opened && args.copied) {
    return null;
  }
  if (!args.opened && !args.copied) {
    return "Could not copy the device code or open the approval page. Copy the code manually and try again.";
  }
  if (!args.opened) {
    return "Device code copied, but the approval page could not be opened. Try again.";
  }
  return "Approval page opened, but the device code was not copied. Copy it manually before approving.";
}

function isCurrentStarting(
  stateValue: CodexDeviceAuthFlowState,
  requestId: string,
): boolean {
  return stateValue.status === "starting" && stateValue.requestId === requestId;
}

function isCurrentActive(
  stateValue: CodexDeviceAuthFlowState,
  requestId: string,
): stateValue is ActiveCodexDeviceAuthFlowState {
  return (
    (stateValue.status === "pending" || stateValue.status === "polling") &&
    stateValue.requestId === requestId
  );
}

function isActive(
  stateValue: CodexDeviceAuthFlowState,
): stateValue is ActiveCodexDeviceAuthFlowState {
  return stateValue.status === "pending" || stateValue.status === "polling";
}

function activeFlowOrExpired(
  flow: CodexDeviceAuthFlowState,
  requestId: string,
): number {
  return isCurrentActive(flow, requestId) ? flow.expiresAtMs : 0;
}

const startCodexDeviceAuth$ = command(
  async ({ get }, scope: CodexDeviceAuthScope, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroCodexDeviceAuthContract, {
      apiBase: "www",
    });
    const result = await accept(
      client.start({
        body: { scope },
        fetchOptions: { signal },
      }),
      [200],
      { toast: false },
    );
    signal.throwIfAborted();
    return result.body;
  },
);

const completeCodexDeviceAuth$ = command(
  async ({ get }, sessionToken: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroCodexDeviceAuthContract, {
      apiBase: "www",
    });
    const result = await accept(
      client.complete({
        body: { sessionToken },
        fetchOptions: { signal },
      }),
      [200],
      { toast: false },
    );
    signal.throwIfAborted();
    return result.body;
  },
);

const cancelCodexDeviceAuth$ = command(
  async ({ get }, sessionToken: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroCodexDeviceAuthContract, {
      apiBase: "www",
    });
    const result = await accept(
      client.cancel({
        body: { sessionToken },
        fetchOptions: { signal },
      }),
      [200],
      { toast: false },
    );
    signal.throwIfAborted();
    return result.body;
  },
);

interface CodexDeviceAuthSignalContext {
  scope: CodexDeviceAuthScope;
  reloadProviders$: Command<void, []>;
  internalDialogState$: State<CodexDeviceAuthDialogState>;
  internalFlowState$: State<CodexDeviceAuthFlowState>;
  resetFlowSignal$: ReturnType<typeof resetSignal>;
}

function createCodexSetDialogState$(ctx: CodexDeviceAuthSignalContext) {
  return command(({ set }, next: CodexDeviceAuthDialogState) => {
    set(ctx.internalDialogState$, next);
    if (!next.open) {
      set(ctx.resetFlowSignal$);
      set(ctx.internalFlowState$, createIdleFlowState());
    }
  });
}

function createCodexPollFlow$(ctx: CodexDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, requestId: string, signal: AbortSignal) => {
      let completed = false;
      let expired = false;

      await setLoop(
        async (loopSignal) => {
          const remainingMs =
            activeFlowOrExpired(get(ctx.internalFlowState$), requestId) - now();
          if (remainingMs <= 0) {
            expired = true;
            return true;
          }

          const current = get(ctx.internalFlowState$);
          if (!isCurrentActive(current, requestId)) {
            return true;
          }

          set(ctx.internalFlowState$, { ...current, status: "polling" });
          const completion = await settle(
            set(completeCodexDeviceAuth$, current.sessionToken, loopSignal),
            loopSignal,
          );
          loopSignal.throwIfAborted();

          const latest = get(ctx.internalFlowState$);
          if (!isCurrentActive(latest, requestId)) {
            return true;
          }

          if (!completion.ok) {
            set(ctx.internalFlowState$, {
              status: "error",
              message: codexDeviceAuthErrorMessage(completion.error),
            });
            return true;
          }

          if (completion.value.status === "complete") {
            set(ctx.reloadProviders$);
            toast.success("ChatGPT connected");
            set(ctx.internalDialogState$, createInitialDialogState());
            set(ctx.internalFlowState$, createIdleFlowState());
            completed = true;
            return true;
          }

          set(ctx.internalFlowState$, {
            ...latest,
            status: "pending",
            errorMessage: completion.value.errorMessage,
          });

          const nextRemainingMs = latest.expiresAtMs - now();
          if (nextRemainingMs <= 0) {
            expired = true;
            return true;
          }
          await delay(Math.min(latest.pollIntervalMs, nextRemainingMs), {
            signal: loopSignal,
          });
          loopSignal.throwIfAborted();
          return false;
        },
        0,
        signal,
      );

      const latest = get(ctx.internalFlowState$);
      if (expired && isCurrentActive(latest, requestId)) {
        set(ctx.internalFlowState$, {
          status: "expired",
          message: "Codex connection session expired. Start again to retry.",
        });
      }
      return completed;
    },
  );
}

function createCodexRunFlow$(
  ctx: CodexDeviceAuthSignalContext,
  pollFlow$: ReturnType<typeof createCodexPollFlow$>,
) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const requestId = createRequestId(ctx.scope);
      set(ctx.internalFlowState$, { status: "starting", requestId });

      const started = await settle(
        set(startCodexDeviceAuth$, ctx.scope, signal),
        signal,
      );
      signal.throwIfAborted();

      if (!isCurrentStarting(get(ctx.internalFlowState$), requestId)) {
        return false;
      }
      if (!started.ok) {
        set(ctx.internalFlowState$, {
          status: "error",
          message: codexDeviceAuthErrorMessage(started.error),
        });
        return false;
      }

      const expiresAtMs =
        now() + secondsToMilliseconds(started.value.expiresIn);
      const pollIntervalMs = Math.max(
        secondsToMilliseconds(started.value.interval),
        CODEX_DEVICE_AUTH_MIN_POLL_MS,
      );

      set(ctx.internalFlowState$, {
        status: "pending",
        requestId,
        sessionToken: started.value.sessionToken,
        browserUrl: started.value.browserUrl,
        verificationCode: started.value.verificationCode,
        expiresAtMs,
        pollIntervalMs,
        approvalOpened: false,
        codeCopied: false,
        errorMessage: null,
      });

      return await set(pollFlow$, requestId, signal);
    },
  );
}

function createCodexRun$(
  ctx: CodexDeviceAuthSignalContext,
  runFlow$: ReturnType<typeof createCodexRunFlow$>,
) {
  return command(async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(ctx.resetFlowSignal$, signal);
    return await set(runFlow$, flowSignal);
  });
}

function createCodexOpenApprovalPage$(ctx: CodexDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const current = get(ctx.internalFlowState$);
      if (!isActive(current)) {
        return false;
      }
      const result = await copyCodeAndOpenApprovalPage(current);
      signal.throwIfAborted();
      const latest = get(ctx.internalFlowState$);
      if (!isCurrentActive(latest, current.requestId)) {
        return result.opened;
      }
      set(ctx.internalFlowState$, {
        ...latest,
        approvalOpened: result.opened || latest.approvalOpened,
        codeCopied: result.copied || latest.codeCopied,
        errorMessage: approvalAttemptErrorMessage(result),
      });
      return result.opened;
    },
  );
}

function createCodexClose$(ctx: CodexDeviceAuthSignalContext) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(ctx.internalFlowState$);
    const sessionToken = isActive(current) ? current.sessionToken : null;
    set(ctx.resetFlowSignal$);
    set(ctx.internalDialogState$, createInitialDialogState());
    set(ctx.internalFlowState$, createIdleFlowState());

    if (!sessionToken) {
      return;
    }

    await settle(set(cancelCodexDeviceAuth$, sessionToken, signal), signal);
    signal.throwIfAborted();
  });
}

function createCodexAutoStartRef(
  ctx: CodexDeviceAuthSignalContext,
  runFlow$: ReturnType<typeof createCodexRunFlow$>,
) {
  const autoStart$ = command(
    async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
      if (get(ctx.internalFlowState$).status !== "idle") {
        return;
      }
      const flowSignal = set(ctx.resetFlowSignal$, signal);
      signal.addEventListener(
        "abort",
        () => {
          if (get(ctx.internalFlowState$).status === "starting") {
            set(ctx.internalFlowState$, createIdleFlowState());
          }
        },
        { once: true },
      );
      await set(runFlow$, flowSignal);
    },
  );
  return onRef(autoStart$);
}

function createCodexDeviceAuthSignals(
  scope: CodexDeviceAuthScope,
  reloadProviders$: Command<void, []>,
) {
  const ctx: CodexDeviceAuthSignalContext = {
    scope,
    reloadProviders$,
    internalDialogState$: state(createInitialDialogState()),
    internalFlowState$: state<CodexDeviceAuthFlowState>(createIdleFlowState()),
    resetFlowSignal$: resetSignal(),
  };
  const pollFlow$ = createCodexPollFlow$(ctx);
  const runFlow$ = createCodexRunFlow$(ctx, pollFlow$);

  return {
    dialogState$: computed((get) => {
      return get(ctx.internalDialogState$);
    }),
    flowState$: computed((get) => {
      return get(ctx.internalFlowState$);
    }),
    setDialogState$: createCodexSetDialogState$(ctx),
    openApprovalPage$: createCodexOpenApprovalPage$(ctx),
    close$: createCodexClose$(ctx),
    run$: createCodexRun$(ctx, runFlow$),
    autoStartRef$: createCodexAutoStartRef(ctx, runFlow$),
  };
}

export const {
  dialogState$: codexDeviceAuthDialogState$,
  flowState$: codexDeviceAuthFlowState$,
  setDialogState$: setCodexDeviceAuthDialogState$,
  openApprovalPage$: openCodexDeviceAuthApprovalPage$,
  close$: closeCodexDeviceAuthDialog$,
  run$: runCodexDeviceAuth$,
  autoStartRef$: codexDeviceAuthAutoStartRef$,
} = createCodexDeviceAuthSignals("org", reloadOrgModelProviders$);

export const {
  dialogState$: codexDeviceAuthDialogStatePersonal$,
  flowState$: codexDeviceAuthFlowStatePersonal$,
  setDialogState$: setCodexDeviceAuthDialogStatePersonal$,
  openApprovalPage$: openCodexDeviceAuthApprovalPagePersonal$,
  close$: closeCodexDeviceAuthDialogPersonal$,
  run$: runCodexDeviceAuthPersonal$,
  autoStartRef$: codexDeviceAuthAutoStartRefPersonal$,
} = createCodexDeviceAuthSignals("personal", reloadPersonalModelProviders$);

export type { CodexDeviceAuthFlowState };
