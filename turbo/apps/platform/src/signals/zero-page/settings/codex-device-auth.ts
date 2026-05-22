import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroCodexDeviceAuthContract,
  type CodexDeviceAuthScope,
} from "@vm0/api-contracts/contracts/zero-codex-device-auth";

import { ApiError, accept } from "../../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../../api-client.ts";
import { reloadOrgModelProviders$ } from "../../external/org-model-providers.ts";
import { reloadPersonalModelProviders$ } from "../../external/personal-model-providers.ts";
import { onRef, resetSignal, settle } from "../../utils.ts";
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

type FlowSetter = (next: CodexDeviceAuthFlowState) => void;
type FlowGetter = () => CodexDeviceAuthFlowState;

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

const internalCodexDeviceAuthDialogState$ = state<CodexDeviceAuthDialogState>(
  createInitialDialogState(),
);
const internalCodexDeviceAuthFlowState$ = state<CodexDeviceAuthFlowState>(
  createIdleFlowState(),
);
const internalCodexDeviceAuthDialogStatePersonal$ =
  state<CodexDeviceAuthDialogState>(createInitialDialogState());
const internalCodexDeviceAuthFlowStatePersonal$ =
  state<CodexDeviceAuthFlowState>(createIdleFlowState());
const resetCodexDeviceAuthFlowSignal$ = resetSignal();
const resetCodexDeviceAuthFlowSignalPersonal$ = resetSignal();

export const codexDeviceAuthDialogState$ = computed((get) => {
  return get(internalCodexDeviceAuthDialogState$);
});

export const codexDeviceAuthFlowState$ = computed((get) => {
  return get(internalCodexDeviceAuthFlowState$);
});

export const codexDeviceAuthDialogStatePersonal$ = computed((get) => {
  return get(internalCodexDeviceAuthDialogStatePersonal$);
});

export const codexDeviceAuthFlowStatePersonal$ = computed((get) => {
  return get(internalCodexDeviceAuthFlowStatePersonal$);
});

export const setCodexDeviceAuthDialogState$ = command(
  ({ set }, next: CodexDeviceAuthDialogState) => {
    set(internalCodexDeviceAuthDialogState$, next);
    if (!next.open) {
      set(resetCodexDeviceAuthFlowSignal$);
      set(internalCodexDeviceAuthFlowState$, createIdleFlowState());
    }
  },
);

export const setCodexDeviceAuthDialogStatePersonal$ = command(
  ({ set }, next: CodexDeviceAuthDialogState) => {
    set(internalCodexDeviceAuthDialogStatePersonal$, next);
    if (!next.open) {
      set(resetCodexDeviceAuthFlowSignalPersonal$);
      set(internalCodexDeviceAuthFlowStatePersonal$, createIdleFlowState());
    }
  },
);

function createRequestId(scope: CodexDeviceAuthScope): string {
  return `${scope}-codex-device-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function startCodexDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly scope: CodexDeviceAuthScope;
  readonly signal: AbortSignal;
}) {
  const client = args.createClient(zeroCodexDeviceAuthContract);
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

async function completeCodexDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}) {
  const client = args.createClient(zeroCodexDeviceAuthContract);
  const result = await accept(
    client.complete({
      body: { sessionToken: args.sessionToken },
      fetchOptions: { signal: args.signal },
    }),
    [200],
    { toast: false },
  );
  return result.body;
}

async function cancelCodexDeviceAuth(args: {
  readonly createClient: ZeroClientFactory;
  readonly sessionToken: string;
  readonly signal: AbortSignal;
}) {
  const client = args.createClient(zeroCodexDeviceAuthContract);
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

async function pollCodexDeviceAuth(args: {
  readonly requestId: string;
  readonly createClient: ZeroClientFactory;
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly reloadProviders: () => void;
  readonly closeDialog: () => void;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  while (Date.now() < activeFlowOrExpired(args.getFlow(), args.requestId)) {
    const current = args.getFlow();
    if (!isCurrentActive(current, args.requestId)) {
      return false;
    }

    args.setFlow({ ...current, status: "polling" });
    const completed = await settle(
      completeCodexDeviceAuth({
        createClient: args.createClient,
        sessionToken: current.sessionToken,
        signal: args.signal,
      }),
      args.signal,
    );
    args.signal.throwIfAborted();

    const latest = args.getFlow();
    if (!isCurrentActive(latest, args.requestId)) {
      return false;
    }

    if (!completed.ok) {
      args.setFlow({
        status: "error",
        message: codexDeviceAuthErrorMessage(completed.error),
      });
      return false;
    }

    if (completed.value.status === "complete") {
      args.reloadProviders();
      toast.success("ChatGPT connected");
      args.closeDialog();
      return true;
    }

    args.setFlow({
      ...latest,
      status: "pending",
      errorMessage: completed.value.errorMessage,
    });

    const remainingMs = latest.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(latest.pollIntervalMs, remainingMs), {
      signal: args.signal,
    });
    args.signal.throwIfAborted();
  }

  const latest = args.getFlow();
  if (isCurrentActive(latest, args.requestId)) {
    args.setFlow({
      status: "expired",
      message: "Codex connection session expired. Start again to retry.",
    });
  }
  return false;
}

function activeFlowOrExpired(
  flow: CodexDeviceAuthFlowState,
  requestId: string,
): number {
  return isCurrentActive(flow, requestId) ? flow.expiresAtMs : 0;
}

async function runCodexDeviceAuthFlow(args: {
  readonly scope: CodexDeviceAuthScope;
  readonly createClient: ZeroClientFactory;
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly reloadProviders: () => void;
  readonly closeDialog: () => void;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const requestId = createRequestId(args.scope);
  args.setFlow({ status: "starting", requestId });

  const started = await settle(
    startCodexDeviceAuth({
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
      message: codexDeviceAuthErrorMessage(started.error),
    });
    return false;
  }

  const expiresAtMs =
    Date.now() + secondsToMilliseconds(started.value.expiresIn);
  const pollIntervalMs = Math.max(
    secondsToMilliseconds(started.value.interval),
    CODEX_DEVICE_AUTH_MIN_POLL_MS,
  );

  args.setFlow({
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

  return await pollCodexDeviceAuth({
    requestId,
    createClient: args.createClient,
    getFlow: args.getFlow,
    setFlow: args.setFlow,
    reloadProviders: args.reloadProviders,
    closeDialog: args.closeDialog,
    signal: args.signal,
  });
}

async function openCodexDeviceAuthApprovalPage(args: {
  readonly getFlow: FlowGetter;
  readonly setFlow: FlowSetter;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const current = args.getFlow();
  if (!isActive(current)) {
    return false;
  }
  const result = await copyCodeAndOpenApprovalPage(current);
  args.signal.throwIfAborted();
  const latest = args.getFlow();
  if (!isCurrentActive(latest, current.requestId)) {
    return result.opened;
  }
  args.setFlow({
    ...latest,
    approvalOpened: result.opened || latest.approvalOpened,
    codeCopied: result.copied || latest.codeCopied,
    errorMessage: approvalAttemptErrorMessage(result),
  });
  return result.opened;
}

async function closeCodexDeviceAuthDialog(args: {
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
    cancelCodexDeviceAuth({
      createClient: args.createClient,
      sessionToken,
      signal: args.signal,
    }),
    args.signal,
  );
  args.signal.throwIfAborted();
}

export const openCodexDeviceAuthApprovalPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    return await openCodexDeviceAuthApprovalPage({
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowState$, next);
      },
      signal,
    });
  },
);

export const openCodexDeviceAuthApprovalPagePersonal$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    return await openCodexDeviceAuthApprovalPage({
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowStatePersonal$, next);
      },
      signal,
    });
  },
);

export const closeCodexDeviceAuthDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await closeCodexDeviceAuthDialog({
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowState$, next);
      },
      closeDialog: () => {
        set(internalCodexDeviceAuthDialogState$, createInitialDialogState());
      },
      resetFlow: () => {
        set(resetCodexDeviceAuthFlowSignal$);
      },
      signal,
    });
  },
);

export const closeCodexDeviceAuthDialogPersonal$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await closeCodexDeviceAuthDialog({
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowStatePersonal$, next);
      },
      closeDialog: () => {
        set(
          internalCodexDeviceAuthDialogStatePersonal$,
          createInitialDialogState(),
        );
      },
      resetFlow: () => {
        set(resetCodexDeviceAuthFlowSignalPersonal$);
      },
      signal,
    });
  },
);

export const runCodexDeviceAuth$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(resetCodexDeviceAuthFlowSignal$, signal);
    return await runCodexDeviceAuthFlow({
      scope: "org",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowState$, next);
      },
      reloadProviders: () => {
        set(reloadOrgModelProviders$);
      },
      closeDialog: () => {
        set(internalCodexDeviceAuthDialogState$, createInitialDialogState());
        set(internalCodexDeviceAuthFlowState$, createIdleFlowState());
      },
      signal: flowSignal,
    });
  },
);

export const runCodexDeviceAuthPersonal$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const flowSignal = set(resetCodexDeviceAuthFlowSignalPersonal$, signal);
    return await runCodexDeviceAuthFlow({
      scope: "personal",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowStatePersonal$, next);
      },
      reloadProviders: () => {
        set(reloadPersonalModelProviders$);
      },
      closeDialog: () => {
        set(
          internalCodexDeviceAuthDialogStatePersonal$,
          createInitialDialogState(),
        );
        set(internalCodexDeviceAuthFlowStatePersonal$, createIdleFlowState());
      },
      signal: flowSignal,
    });
  },
);

const startCodexDeviceAuthOnRef$ = command(
  async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
    if (get(internalCodexDeviceAuthFlowState$).status !== "idle") {
      return;
    }
    const flowSignal = set(resetCodexDeviceAuthFlowSignal$, signal);
    signal.addEventListener(
      "abort",
      () => {
        if (get(internalCodexDeviceAuthFlowState$).status === "starting") {
          set(internalCodexDeviceAuthFlowState$, createIdleFlowState());
        }
      },
      { once: true },
    );
    await runCodexDeviceAuthFlow({
      scope: "org",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowState$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowState$, next);
      },
      reloadProviders: () => {
        set(reloadOrgModelProviders$);
      },
      closeDialog: () => {
        set(internalCodexDeviceAuthDialogState$, createInitialDialogState());
        set(internalCodexDeviceAuthFlowState$, createIdleFlowState());
      },
      signal: flowSignal,
    });
  },
);

const startCodexDeviceAuthPersonalOnRef$ = command(
  async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
    if (get(internalCodexDeviceAuthFlowStatePersonal$).status !== "idle") {
      return;
    }
    const flowSignal = set(resetCodexDeviceAuthFlowSignalPersonal$, signal);
    signal.addEventListener(
      "abort",
      () => {
        if (
          get(internalCodexDeviceAuthFlowStatePersonal$).status === "starting"
        ) {
          set(internalCodexDeviceAuthFlowStatePersonal$, createIdleFlowState());
        }
      },
      { once: true },
    );
    await runCodexDeviceAuthFlow({
      scope: "personal",
      createClient: get(zeroClient$),
      getFlow: () => {
        return get(internalCodexDeviceAuthFlowStatePersonal$);
      },
      setFlow: (next) => {
        set(internalCodexDeviceAuthFlowStatePersonal$, next);
      },
      reloadProviders: () => {
        set(reloadPersonalModelProviders$);
      },
      closeDialog: () => {
        set(
          internalCodexDeviceAuthDialogStatePersonal$,
          createInitialDialogState(),
        );
        set(internalCodexDeviceAuthFlowStatePersonal$, createIdleFlowState());
      },
      signal: flowSignal,
    });
  },
);

export const codexDeviceAuthAutoStartRef$ = onRef(startCodexDeviceAuthOnRef$);

export const codexDeviceAuthAutoStartRefPersonal$ = onRef(
  startCodexDeviceAuthPersonalOnRef$,
);

export type { CodexDeviceAuthFlowState };
