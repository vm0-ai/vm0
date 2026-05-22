import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroClaudeCodeDeviceAuthContract,
  type ClaudeCodeDeviceAuthScope,
} from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";

import { ApiError, accept } from "../../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../../api-client.ts";
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

type FlowSetter = (next: ClaudeCodeDeviceAuthFlowState) => void;
type FlowGetter = () => ClaudeCodeDeviceAuthFlowState;

function createInitialDialogState(): ClaudeCodeDeviceAuthDialogState {
  return {
    open: false,
    mode: "connect",
  };
}

function createIdleFlowState(): ClaudeCodeDeviceAuthFlowState {
  return { status: "idle" };
}

const internalClaudeCodeDeviceAuthDialogState$ =
  state<ClaudeCodeDeviceAuthDialogState>(createInitialDialogState());
const internalClaudeCodeDeviceAuthFlowState$ =
  state<ClaudeCodeDeviceAuthFlowState>(createIdleFlowState());
const internalClaudeCodeDeviceAuthDialogStatePersonal$ =
  state<ClaudeCodeDeviceAuthDialogState>(createInitialDialogState());
const internalClaudeCodeDeviceAuthFlowStatePersonal$ =
  state<ClaudeCodeDeviceAuthFlowState>(createIdleFlowState());
const resetClaudeCodeDeviceAuthFlowSignal$ = resetSignal();
const resetClaudeCodeDeviceAuthFlowSignalPersonal$ = resetSignal();

export const claudeCodeDeviceAuthDialogState$ = computed((get) => {
  return get(internalClaudeCodeDeviceAuthDialogState$);
});

export const claudeCodeDeviceAuthFlowState$ = computed((get) => {
  return get(internalClaudeCodeDeviceAuthFlowState$);
});

export const claudeCodeDeviceAuthDialogStatePersonal$ = computed((get) => {
  return get(internalClaudeCodeDeviceAuthDialogStatePersonal$);
});

export const claudeCodeDeviceAuthFlowStatePersonal$ = computed((get) => {
  return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
});

export const setClaudeCodeDeviceAuthDialogState$ = command(
  ({ set }, next: ClaudeCodeDeviceAuthDialogState) => {
    set(internalClaudeCodeDeviceAuthDialogState$, next);
    if (!next.open) {
      set(resetClaudeCodeDeviceAuthFlowSignal$);
      set(internalClaudeCodeDeviceAuthFlowState$, createIdleFlowState());
    }
  },
);

export const setClaudeCodeDeviceAuthDialogStatePersonal$ = command(
  ({ set }, next: ClaudeCodeDeviceAuthDialogState) => {
    set(internalClaudeCodeDeviceAuthDialogStatePersonal$, next);
    if (!next.open) {
      set(resetClaudeCodeDeviceAuthFlowSignalPersonal$);
      set(
        internalClaudeCodeDeviceAuthFlowStatePersonal$,
        createIdleFlowState(),
      );
    }
  },
);

function createRequestId(scope: ClaudeCodeDeviceAuthScope): string {
  return `${scope}-claude-code-device-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function startClaudeCodeDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly scope: ClaudeCodeDeviceAuthScope;
  readonly signal: AbortSignal;
}) {
  const client = args.createClient(zeroClaudeCodeDeviceAuthContract);
  const result = await accept(
    client.start({
      body: { scope: args.scope },
      fetchOptions: { signal: args.signal },
    }),
    [200],
    { toast: false },
  );
  return result.body;
}

async function completeClaudeCodeDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly sessionToken: string;
  readonly authorizationCode: string;
  readonly signal: AbortSignal;
}) {
  const client = args.createClient(zeroClaudeCodeDeviceAuthContract);
  const result = await accept(
    client.complete({
      body: {
        sessionToken: args.sessionToken,
        authorizationCode: args.authorizationCode,
      },
      fetchOptions: { signal: args.signal },
    }),
    [200],
    { toast: false },
  );
  return result.body;
}

async function cancelClaudeCodeDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}) {
  const client = args.createClient(zeroClaudeCodeDeviceAuthContract);
  const result = await accept(
    client.cancel({
      body: { sessionToken: args.sessionToken },
      fetchOptions: { signal: args.signal },
    }),
    [200],
    { toast: false },
  );
  return result.body;
}

async function runClaudeCodeDeviceAuthFlow(args: {
  readonly scope: ClaudeCodeDeviceAuthScope;
  readonly createClient: ZeroClientFactory;
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const requestId = createRequestId(args.scope);
  args.setFlow({ status: "starting", requestId });

  const started = await settle(
    startClaudeCodeDeviceAuth({
      createClient: args.createClient,
      scope: args.scope,
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();

  if (!isCurrentStarting(args.getFlow(), requestId)) {
    return false;
  }
  if (!started.ok) {
    args.setFlow({
      status: "error",
      message: claudeCodeDeviceAuthErrorMessage(started.error),
    });
    return false;
  }

  args.setFlow({
    status: "pending",
    requestId,
    sessionToken: started.value.sessionToken,
    browserUrl: started.value.browserUrl,
    expiresAtMs: Date.now() + secondsToMilliseconds(started.value.expiresIn),
    authorizationCode: "",
    approvalOpened: false,
    errorMessage: null,
  });
  return true;
}

function openClaudeCodeDeviceAuthApprovalPage(args: {
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly signal: AbortSignal;
}): boolean {
  const current = args.getFlow();
  if (!isActive(current)) {
    return false;
  }
  const opened = openApprovalPage(current.browserUrl);
  args.signal.throwIfAborted();
  const latest = args.getFlow();
  if (!isCurrentActive(latest, current.requestId)) {
    return opened;
  }
  args.setFlow({
    ...latest,
    approvalOpened: opened || latest.approvalOpened,
    errorMessage: opened
      ? null
      : "The approval page could not be opened. Use the link manually and paste the code here.",
  });
  return opened;
}

function setAuthorizationCode(args: {
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly authorizationCode: string;
}): void {
  const current = args.getFlow();
  if (!isActive(current)) {
    return;
  }
  args.setFlow({
    ...current,
    authorizationCode: args.authorizationCode,
    errorMessage: null,
  });
}

async function submitClaudeCodeDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly reloadProviders: () => void;
  readonly closeDialog: () => void;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const current = args.getFlow();
  if (!isActive(current)) {
    return false;
  }
  if (current.expiresAtMs <= Date.now()) {
    args.setFlow({
      status: "expired",
      message: "Claude Code connection session expired. Start again to retry.",
    });
    return false;
  }
  if (!current.authorizationCode.trim()) {
    args.setFlow({
      ...current,
      errorMessage: "Paste the Claude Code authorization code to continue.",
    });
    return false;
  }

  args.setFlow({ ...current, status: "submitting", errorMessage: null });
  const completed = await settle(
    completeClaudeCodeDeviceAuth({
      createClient: args.createClient,
      sessionToken: current.sessionToken,
      authorizationCode: current.authorizationCode,
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();

  const latest = args.getFlow();
  if (!isCurrentActive(latest, current.requestId)) {
    return false;
  }
  if (!completed.ok) {
    const message = claudeCodeDeviceAuthErrorMessage(completed.error);
    if (completed.error instanceof ApiError && completed.error.status === 400) {
      args.setFlow({
        ...latest,
        status: "pending",
        errorMessage: message,
      });
      return false;
    }
    args.setFlow({ status: "error", message });
    return false;
  }

  args.reloadProviders();
  toast.success("Claude Code connected");
  args.closeDialog();
  return true;
}

async function closeClaudeCodeDeviceAuthDialog(args: {
  readonly createClient: ZeroClientFactory;
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly closeDialog: () => void;
  readonly resetFlow: () => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  const current = args.getFlow();
  const sessionToken = isActive(current) ? current.sessionToken : null;
  args.resetFlow();
  args.closeDialog();
  args.setFlow(createIdleFlowState());

  if (!sessionToken) {
    return;
  }

  await settle(
    cancelClaudeCodeDeviceAuth({
      createClient: args.createClient,
      sessionToken,
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();
}

export const openClaudeCodeDeviceAuthApprovalPage$ = command(
  ({ get, set }, signal: AbortSignal) => {
    return openClaudeCodeDeviceAuthApprovalPage({
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowState$, next);
      },
      signal,
    });
  },
);

export const openClaudeCodeDeviceAuthApprovalPagePersonal$ = command(
  ({ get, set }, signal: AbortSignal) => {
    return openClaudeCodeDeviceAuthApprovalPage({
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowStatePersonal$, next);
      },
      signal,
    });
  },
);

export const setClaudeCodeDeviceAuthAuthorizationCode$ = command(
  ({ get, set }, authorizationCode: string) => {
    setAuthorizationCode({
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowState$, next);
      },
      authorizationCode,
    });
  },
);

export const setClaudeCodeDeviceAuthAuthorizationCodePersonal$ = command(
  ({ get, set }, authorizationCode: string) => {
    setAuthorizationCode({
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowStatePersonal$, next);
      },
      authorizationCode,
    });
  },
);

export const submitClaudeCodeDeviceAuth$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    return await submitClaudeCodeDeviceAuth({
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowState$, next);
      },
      reloadProviders: () => {
        set(reloadOrgModelProviders$);
      },
      closeDialog: () => {
        set(
          internalClaudeCodeDeviceAuthDialogState$,
          createInitialDialogState(),
        );
        set(internalClaudeCodeDeviceAuthFlowState$, createIdleFlowState());
      },
      signal,
    });
  },
);

export const submitClaudeCodeDeviceAuthPersonal$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    return await submitClaudeCodeDeviceAuth({
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowStatePersonal$, next);
      },
      reloadProviders: () => {
        set(reloadPersonalModelProviders$);
      },
      closeDialog: () => {
        set(
          internalClaudeCodeDeviceAuthDialogStatePersonal$,
          createInitialDialogState(),
        );
        set(
          internalClaudeCodeDeviceAuthFlowStatePersonal$,
          createIdleFlowState(),
        );
      },
      signal,
    });
  },
);

export const closeClaudeCodeDeviceAuthDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await closeClaudeCodeDeviceAuthDialog({
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowState$, next);
      },
      closeDialog: () => {
        set(
          internalClaudeCodeDeviceAuthDialogState$,
          createInitialDialogState(),
        );
      },
      resetFlow: () => {
        set(resetClaudeCodeDeviceAuthFlowSignal$);
      },
      signal,
    });
  },
);

export const closeClaudeCodeDeviceAuthDialogPersonal$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await closeClaudeCodeDeviceAuthDialog({
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowStatePersonal$, next);
      },
      closeDialog: () => {
        set(
          internalClaudeCodeDeviceAuthDialogStatePersonal$,
          createInitialDialogState(),
        );
      },
      resetFlow: () => {
        set(resetClaudeCodeDeviceAuthFlowSignalPersonal$);
      },
      signal,
    });
  },
);

export const runClaudeCodeDeviceAuth$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(resetClaudeCodeDeviceAuthFlowSignal$, signal);
    return await runClaudeCodeDeviceAuthFlow({
      scope: "org",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowState$, next);
      },
      signal: flowSignal,
    });
  },
);

export const runClaudeCodeDeviceAuthPersonal$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(
      resetClaudeCodeDeviceAuthFlowSignalPersonal$,
      signal,
    );
    return await runClaudeCodeDeviceAuthFlow({
      scope: "personal",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowStatePersonal$, next);
      },
      signal: flowSignal,
    });
  },
);

const startClaudeCodeDeviceAuthOnRef$ = command(
  async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
    if (get(internalClaudeCodeDeviceAuthFlowState$).status !== "idle") {
      return;
    }
    const flowSignal = set(resetClaudeCodeDeviceAuthFlowSignal$, signal);
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalClaudeCodeDeviceAuthFlowState$).status === "starting") {
          set(internalClaudeCodeDeviceAuthFlowState$, createIdleFlowState());
        }
      },
      { once: true },
    );
    await runClaudeCodeDeviceAuthFlow({
      scope: "org",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowState$, next);
      },
      signal: flowSignal,
    });
  },
);

const startClaudeCodeDeviceAuthPersonalOnRef$ = command(
  async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
    if (get(internalClaudeCodeDeviceAuthFlowStatePersonal$).status !== "idle") {
      return;
    }
    const flowSignal = set(
      resetClaudeCodeDeviceAuthFlowSignalPersonal$,
      signal,
    );
    signal.addEventListener(
      "abort",
      () => {
        if (
          get(internalClaudeCodeDeviceAuthFlowStatePersonal$).status ===
          "starting"
        ) {
          set(
            internalClaudeCodeDeviceAuthFlowStatePersonal$,
            createIdleFlowState(),
          );
        }
      },
      { once: true },
    );
    await runClaudeCodeDeviceAuthFlow({
      scope: "personal",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalClaudeCodeDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalClaudeCodeDeviceAuthFlowStatePersonal$, next);
      },
      signal: flowSignal,
    });
  },
);

export const claudeCodeDeviceAuthAutoStartRef$ = onRef(
  startClaudeCodeDeviceAuthOnRef$,
);

export const claudeCodeDeviceAuthAutoStartRefPersonal$ = onRef(
  startClaudeCodeDeviceAuthPersonalOnRef$,
);

export type { ClaudeCodeDeviceAuthFlowState };
