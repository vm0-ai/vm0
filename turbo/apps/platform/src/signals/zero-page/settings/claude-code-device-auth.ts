import { command, computed, state, type Command, type State } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroClaudeCodeDeviceAuthContract,
  type ClaudeCodeDeviceAuthScope,
} from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";

import { ApiError, accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import { zeroClient$ } from "../../api-client.ts";
import { reloadOrgModelProviders$ } from "../../external/org-model-providers.ts";
import { reloadPersonalModelProviders$ } from "../../external/personal-model-providers.ts";
import { onRef, resetSignal, settle } from "../../utils.ts";

type ClaudeCodeDeviceAuthDialogMode = "connect" | "reconnect";

interface ClaudeCodeDeviceAuthDialogState {
  open: boolean;
  mode: ClaudeCodeDeviceAuthDialogMode;
}

type ActiveClaudeCodeDeviceAuthFlowState = {
  readonly status: "pending" | "submitting";
  readonly requestId: string;
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly expiresAtMs: number;
  readonly authorizationCode: string;
  readonly approvalOpened: boolean;
  readonly errorMessage: string | null;
};

type ClaudeCodeDeviceAuthFlowState =
  | { readonly status: "idle" }
  | { readonly status: "starting"; readonly requestId: string }
  | ActiveClaudeCodeDeviceAuthFlowState
  | { readonly status: "expired"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

function createInitialDialogState(): ClaudeCodeDeviceAuthDialogState {
  return {
    open: false,
    mode: "connect",
  };
}

function createIdleFlowState(): ClaudeCodeDeviceAuthFlowState {
  return { status: "idle" };
}

function createRequestId(scope: ClaudeCodeDeviceAuthScope): string {
  return `${scope}-claude-code-device-auth-${now()}-${Math.random().toString(36).slice(2)}`;
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function claudeCodeDeviceAuthErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "Claude Code connection failed";
}

function openApprovalPage(browserUrl: string): boolean {
  const approvalWindow = window.open(browserUrl, "_blank");
  if (!approvalWindow) {
    return false;
  }
  approvalWindow.opener = null;
  return true;
}

function isCurrentStarting(
  stateValue: ClaudeCodeDeviceAuthFlowState,
  requestId: string,
): boolean {
  return stateValue.status === "starting" && stateValue.requestId === requestId;
}

function isCurrentActive(
  stateValue: ClaudeCodeDeviceAuthFlowState,
  requestId: string,
): stateValue is ActiveClaudeCodeDeviceAuthFlowState {
  return (
    (stateValue.status === "pending" || stateValue.status === "submitting") &&
    stateValue.requestId === requestId
  );
}

function isActive(
  stateValue: ClaudeCodeDeviceAuthFlowState,
): stateValue is ActiveClaudeCodeDeviceAuthFlowState {
  return stateValue.status === "pending" || stateValue.status === "submitting";
}

const startClaudeCodeDeviceAuth$ = command(
  async ({ get }, scope: ClaudeCodeDeviceAuthScope, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroClaudeCodeDeviceAuthContract, {
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

const completeClaudeCodeDeviceAuth$ = command(
  async (
    { get },
    sessionToken: string,
    authorizationCode: string,
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroClaudeCodeDeviceAuthContract, {
      apiBase: "www",
    });
    const result = await accept(
      client.complete({
        body: {
          sessionToken,
          authorizationCode,
        },
        fetchOptions: { signal },
      }),
      [200],
      { toast: false },
    );
    signal.throwIfAborted();
    return result.body;
  },
);

const cancelClaudeCodeDeviceAuth$ = command(
  async ({ get }, sessionToken: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroClaudeCodeDeviceAuthContract, {
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

interface ClaudeCodeDeviceAuthSignalContext {
  scope: ClaudeCodeDeviceAuthScope;
  reloadProviders$: Command<void, []>;
  internalDialogState$: State<ClaudeCodeDeviceAuthDialogState>;
  internalFlowState$: State<ClaudeCodeDeviceAuthFlowState>;
  resetFlowSignal$: ReturnType<typeof resetSignal>;
}

function createClaudeCodeSetDialogState$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
) {
  return command(({ set }, next: ClaudeCodeDeviceAuthDialogState) => {
    set(ctx.internalDialogState$, next);
    if (!next.open) {
      set(ctx.resetFlowSignal$);
      set(ctx.internalFlowState$, createIdleFlowState());
    }
  });
}

function createClaudeCodeRunFlow$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const requestId = createRequestId(ctx.scope);
      set(ctx.internalFlowState$, { status: "starting", requestId });

      const started = await settle(
        set(startClaudeCodeDeviceAuth$, ctx.scope, signal),
        signal,
      );
      signal.throwIfAborted();

      if (!isCurrentStarting(get(ctx.internalFlowState$), requestId)) {
        return false;
      }
      if (!started.ok) {
        set(ctx.internalFlowState$, {
          status: "error",
          message: claudeCodeDeviceAuthErrorMessage(started.error),
        });
        return false;
      }

      set(ctx.internalFlowState$, {
        status: "pending",
        requestId,
        sessionToken: started.value.sessionToken,
        browserUrl: started.value.browserUrl,
        expiresAtMs: now() + secondsToMilliseconds(started.value.expiresIn),
        authorizationCode: "",
        approvalOpened: false,
        errorMessage: null,
      });
      return true;
    },
  );
}

function createClaudeCodeRun$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
  runFlow$: ReturnType<typeof createClaudeCodeRunFlow$>,
) {
  return command(async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(ctx.resetFlowSignal$, signal);
    return await set(runFlow$, flowSignal);
  });
}

function createClaudeCodeOpenApprovalPage$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
) {
  return command(({ get, set }, signal: AbortSignal): boolean => {
    const current = get(ctx.internalFlowState$);
    if (!isActive(current)) {
      return false;
    }
    const opened = openApprovalPage(current.browserUrl);
    signal.throwIfAborted();
    const latest = get(ctx.internalFlowState$);
    if (!isCurrentActive(latest, current.requestId)) {
      return opened;
    }
    set(ctx.internalFlowState$, {
      ...latest,
      approvalOpened: opened || latest.approvalOpened,
      errorMessage: opened
        ? null
        : "The approval page could not be opened. Use the link manually and paste the code here.",
    });
    return opened;
  });
}

function createClaudeCodeSetAuthorizationCode$(
  ctx: ClaudeCodeDeviceAuthSignalContext,
) {
  return command(({ get, set }, authorizationCode: string) => {
    const current = get(ctx.internalFlowState$);
    if (!isActive(current)) {
      return;
    }
    set(ctx.internalFlowState$, {
      ...current,
      authorizationCode,
      errorMessage: null,
    });
  });
}

function createClaudeCodeSubmit$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const current = get(ctx.internalFlowState$);
      if (!isActive(current)) {
        return false;
      }
      if (current.expiresAtMs <= now()) {
        set(ctx.internalFlowState$, {
          status: "expired",
          message:
            "Claude Code connection session expired. Start again to retry.",
        });
        return false;
      }
      if (!current.authorizationCode.trim()) {
        set(ctx.internalFlowState$, {
          ...current,
          errorMessage: "Paste the Claude Code authorization code to continue.",
        });
        return false;
      }

      set(ctx.internalFlowState$, {
        ...current,
        status: "submitting",
        errorMessage: null,
      });
      const completed = await settle(
        set(
          completeClaudeCodeDeviceAuth$,
          current.sessionToken,
          current.authorizationCode,
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();

      const latest = get(ctx.internalFlowState$);
      if (!isCurrentActive(latest, current.requestId)) {
        return false;
      }
      if (!completed.ok) {
        const message = claudeCodeDeviceAuthErrorMessage(completed.error);
        if (
          completed.error instanceof ApiError &&
          completed.error.status === 400
        ) {
          set(ctx.internalFlowState$, {
            ...latest,
            status: "pending",
            errorMessage: message,
          });
          return false;
        }
        set(ctx.internalFlowState$, { status: "error", message });
        return false;
      }

      set(ctx.reloadProviders$);
      toast.success("Claude Code connected");
      set(ctx.internalDialogState$, createInitialDialogState());
      set(ctx.internalFlowState$, createIdleFlowState());
      return true;
    },
  );
}

function createClaudeCodeClose$(ctx: ClaudeCodeDeviceAuthSignalContext) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(ctx.internalFlowState$);
    const sessionToken = isActive(current) ? current.sessionToken : null;
    set(ctx.resetFlowSignal$);
    set(ctx.internalDialogState$, createInitialDialogState());
    set(ctx.internalFlowState$, createIdleFlowState());

    if (!sessionToken) {
      return;
    }

    await settle(
      set(cancelClaudeCodeDeviceAuth$, sessionToken, signal),
      signal,
    );
    signal.throwIfAborted();
  });
}

function createClaudeCodeAutoStartRef(
  ctx: ClaudeCodeDeviceAuthSignalContext,
  runFlow$: ReturnType<typeof createClaudeCodeRunFlow$>,
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

function createClaudeCodeDeviceAuthSignals(
  scope: ClaudeCodeDeviceAuthScope,
  reloadProviders$: Command<void, []>,
) {
  const ctx: ClaudeCodeDeviceAuthSignalContext = {
    scope,
    reloadProviders$,
    internalDialogState$: state(createInitialDialogState()),
    internalFlowState$: state<ClaudeCodeDeviceAuthFlowState>(
      createIdleFlowState(),
    ),
    resetFlowSignal$: resetSignal(),
  };
  const runFlow$ = createClaudeCodeRunFlow$(ctx);

  return {
    dialogState$: computed((get) => {
      return get(ctx.internalDialogState$);
    }),
    flowState$: computed((get) => {
      return get(ctx.internalFlowState$);
    }),
    setDialogState$: createClaudeCodeSetDialogState$(ctx),
    openApprovalPage$: createClaudeCodeOpenApprovalPage$(ctx),
    setAuthorizationCode$: createClaudeCodeSetAuthorizationCode$(ctx),
    submit$: createClaudeCodeSubmit$(ctx),
    close$: createClaudeCodeClose$(ctx),
    run$: createClaudeCodeRun$(ctx, runFlow$),
    autoStartRef$: createClaudeCodeAutoStartRef(ctx, runFlow$),
  };
}

export const {
  dialogState$: claudeCodeDeviceAuthDialogState$,
  flowState$: claudeCodeDeviceAuthFlowState$,
  setDialogState$: setClaudeCodeDeviceAuthDialogState$,
  openApprovalPage$: openClaudeCodeDeviceAuthApprovalPage$,
  setAuthorizationCode$: setClaudeCodeDeviceAuthAuthorizationCode$,
  submit$: submitClaudeCodeDeviceAuth$,
  close$: closeClaudeCodeDeviceAuthDialog$,
  run$: runClaudeCodeDeviceAuth$,
  autoStartRef$: claudeCodeDeviceAuthAutoStartRef$,
} = createClaudeCodeDeviceAuthSignals("org", reloadOrgModelProviders$);

export const {
  dialogState$: claudeCodeDeviceAuthDialogStatePersonal$,
  flowState$: claudeCodeDeviceAuthFlowStatePersonal$,
  setDialogState$: setClaudeCodeDeviceAuthDialogStatePersonal$,
  openApprovalPage$: openClaudeCodeDeviceAuthApprovalPagePersonal$,
  setAuthorizationCode$: setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  submit$: submitClaudeCodeDeviceAuthPersonal$,
  close$: closeClaudeCodeDeviceAuthDialogPersonal$,
  run$: runClaudeCodeDeviceAuthPersonal$,
  autoStartRef$: claudeCodeDeviceAuthAutoStartRefPersonal$,
} = createClaudeCodeDeviceAuthSignals(
  "personal",
  reloadPersonalModelProviders$,
);

export type { ClaudeCodeDeviceAuthFlowState };
