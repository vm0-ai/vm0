import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { IconLoader2 } from "@tabler/icons-react";

import {
  closeCodexDeviceAuthDialog$,
  closeCodexDeviceAuthDialogPersonal$,
  codexDeviceAuthDialogState$,
  codexDeviceAuthDialogStatePersonal$,
  codexDeviceAuthFlowState$,
  codexDeviceAuthFlowStatePersonal$,
  openCodexDeviceAuthApprovalPage$,
  openCodexDeviceAuthApprovalPagePersonal$,
  runCodexDeviceAuth$,
  runCodexDeviceAuthPersonal$,
  setCodexDeviceAuthDialogState$,
  setCodexDeviceAuthDialogStatePersonal$,
  type CodexDeviceAuthFlowState,
} from "../../../../signals/zero-page/settings/codex-device-auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorHelpText } from "./connector-help-text.tsx";
import { ProviderIcon } from "./provider-icons.tsx";

type CodexDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

interface CodexDeviceAuthScopeBundle {
  dialog: CodexDeviceAuthDialogState;
  flow: CodexDeviceAuthFlowState;
  setDialog: (next: CodexDeviceAuthDialogState) => void;
  close: (signal: AbortSignal) => Promise<void>;
  openApprovalPage: (signal: AbortSignal) => Promise<boolean>;
  run: (signal: AbortSignal) => Promise<boolean>;
}

export function CodexDeviceAuthDialog() {
  const bundle = useOrgCodexDeviceAuthBundle();
  return <CodexDeviceAuthDialogView bundle={bundle} />;
}

export function PersonalCodexDeviceAuthDialog() {
  const bundle = usePersonalCodexDeviceAuthBundle();
  return <CodexDeviceAuthDialogView bundle={bundle} />;
}

function useOrgCodexDeviceAuthBundle(): CodexDeviceAuthScopeBundle {
  const dialog = useGet(codexDeviceAuthDialogState$);
  const flow = useGet(codexDeviceAuthFlowState$);
  const setDialog = useSet(setCodexDeviceAuthDialogState$);
  const close = useSet(closeCodexDeviceAuthDialog$);
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPage$);
  const [, run] = useLoadableSet(runCodexDeviceAuth$);
  return {
    dialog,
    flow,
    setDialog,
    close,
    openApprovalPage,
    run,
  };
}

function usePersonalCodexDeviceAuthBundle(): CodexDeviceAuthScopeBundle {
  const dialog = useGet(codexDeviceAuthDialogStatePersonal$);
  const flow = useGet(codexDeviceAuthFlowStatePersonal$);
  const setDialog = useSet(setCodexDeviceAuthDialogStatePersonal$);
  const close = useSet(closeCodexDeviceAuthDialogPersonal$);
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPagePersonal$);
  const [, run] = useLoadableSet(runCodexDeviceAuthPersonal$);
  return {
    dialog,
    flow,
    setDialog,
    close,
    openApprovalPage,
    run,
  };
}

function CodexDeviceAuthDialogView({
  bundle,
}: {
  bundle: CodexDeviceAuthScopeBundle;
}) {
  const pageSignal = useGet(pageSignal$);
  const { dialog, flow, setDialog, close, openApprovalPage, run } = bundle;
  const title =
    dialog.mode === "reconnect" ? "Re-connect Codex" : "Connect Codex";

  function handleOpenChange(nextOpen: boolean): void {
    if (nextOpen) {
      setDialog({ ...dialog, open: true });
      return;
    }
    detach(close(pageSignal), Reason.DomCallback);
  }

  function handleStart(): void {
    detach(run(pageSignal), Reason.DomCallback);
  }

  return (
    <Dialog open={dialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <ProviderIcon type="codex-oauth-token" size={20} />
            </div>
            <DialogTitle>{title}</DialogTitle>
          </div>
        </DialogHeader>

        <CodexDeviceAuthBody
          flow={flow}
          mode={dialog.mode}
          onStart={handleStart}
          openApprovalPage={openApprovalPage}
          pageSignal={pageSignal}
        />
      </DialogContent>
    </Dialog>
  );
}

function CodexDeviceAuthBody({
  flow,
  mode,
  onStart,
  openApprovalPage,
  pageSignal,
}: {
  flow: CodexDeviceAuthFlowState;
  mode: "connect" | "reconnect";
  onStart: () => void;
  openApprovalPage: (signal: AbortSignal) => Promise<boolean>;
  pageSignal: AbortSignal;
}) {
  switch (flow.status) {
    case "idle": {
      return <CodexDeviceAuthStartContent mode={mode} onStart={onStart} />;
    }
    case "starting": {
      return (
        <CodexDeviceAuthStartContent mode={mode} onStart={onStart} loading />
      );
    }
    case "pending":
    case "polling": {
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">
              Copy this device code before approving
            </p>
            <p
              className="mt-1 font-mono text-2xl font-semibold tracking-normal"
              data-testid="codex-device-auth-code"
            >
              {flow.verificationCode}
            </p>
          </div>
          {flow.errorMessage && (
            <p className="text-xs text-destructive" role="alert">
              {flow.errorMessage}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              detach(openApprovalPage(pageSignal), Reason.DomCallback);
            }}
            data-testid="codex-device-auth-open"
          >
            Copy code and open approval page
          </Button>
          <p className="text-xs text-muted-foreground" role="status">
            {codexDeviceAuthStatusText(flow)}
          </p>
        </div>
      );
    }
    case "expired":
    case "error": {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-destructive" role="alert">
            {flow.message}
          </p>
          <CodexDeviceAuthStartButton mode={mode} onStart={onStart} />
        </div>
      );
    }
  }
}

function CodexDeviceAuthStartContent({
  mode,
  onStart,
  loading = false,
}: {
  mode: "connect" | "reconnect";
  onStart: () => void;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ConnectorHelpText text="vm0 will start a short-lived Codex login session and show a device code. Open the approval page after the code appears." />
      <CodexDeviceAuthStartButton
        mode={mode}
        onStart={onStart}
        loading={loading}
      />
    </div>
  );
}

function CodexDeviceAuthStartButton({
  mode,
  onStart,
  loading = false,
}: {
  mode: "connect" | "reconnect";
  onStart: () => void;
  loading?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onStart}
      disabled={loading}
      className="w-full gap-2"
      data-testid="codex-device-auth-start"
    >
      {loading && <IconLoader2 size={14} className="animate-spin" />}
      {loading
        ? "Preparing..."
        : mode === "reconnect"
          ? "Reconnect ChatGPT"
          : "Sign in with ChatGPT"}
    </Button>
  );
}

function codexDeviceAuthStatusText(
  flow: Extract<CodexDeviceAuthFlowState, { status: "pending" | "polling" }>,
): string {
  if (!flow.approvalOpened && !flow.codeCopied) {
    return "Open the approval page to continue.";
  }
  if (flow.codeCopied && !flow.approvalOpened) {
    return "Device code copied. Try opening the approval page again.";
  }
  if (!flow.codeCopied) {
    return "Approval page opened. Copy the device code before approving.";
  }
  return flow.status === "polling"
    ? "Checking connection..."
    : "Device code copied. Waiting for approval...";
}
