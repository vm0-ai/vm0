import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { IconLoader2 } from "@tabler/icons-react";

import {
  closeCodexDeviceAuthDialog$,
  closeCodexDeviceAuthDialogPersonal$,
  codexDeviceAuthAutoStartRef$,
  codexDeviceAuthAutoStartRefPersonal$,
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
import { ProviderIcon } from "./provider-icons.tsx";

type CodexDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

type AutoStartRef = (element: HTMLDivElement | null) => void;

interface CodexDeviceAuthScopeBundle {
  dialog: CodexDeviceAuthDialogState;
  flow: CodexDeviceAuthFlowState;
  autoStartRef: AutoStartRef;
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
  const autoStartRef = useSet(codexDeviceAuthAutoStartRef$);
  const setDialog = useSet(setCodexDeviceAuthDialogState$);
  const close = useSet(closeCodexDeviceAuthDialog$);
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPage$);
  const [, run] = useLoadableSet(runCodexDeviceAuth$);
  return {
    dialog,
    flow,
    autoStartRef,
    setDialog,
    close,
    openApprovalPage,
    run,
  };
}

function usePersonalCodexDeviceAuthBundle(): CodexDeviceAuthScopeBundle {
  const dialog = useGet(codexDeviceAuthDialogStatePersonal$);
  const flow = useGet(codexDeviceAuthFlowStatePersonal$);
  const autoStartRef = useSet(codexDeviceAuthAutoStartRefPersonal$);
  const setDialog = useSet(setCodexDeviceAuthDialogStatePersonal$);
  const close = useSet(closeCodexDeviceAuthDialogPersonal$);
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPagePersonal$);
  const [, run] = useLoadableSet(runCodexDeviceAuthPersonal$);
  return {
    dialog,
    flow,
    autoStartRef,
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
  const {
    dialog,
    flow,
    autoStartRef,
    setDialog,
    close,
    openApprovalPage,
    run,
  } = bundle;
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
        <div ref={autoStartRef} className="contents">
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
        </div>
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
      return <CodexDeviceAuthLoadingContent />;
    }
    case "starting": {
      return <CodexDeviceAuthLoadingContent />;
    }
    case "pending":
    case "polling": {
      const statusText = codexDeviceAuthStatusText(flow);
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            <p>
              First click Copy code and open approval page. Then paste the
              device code into OpenAI when prompted. Finally approve access and
              keep this dialog open while vm0 finishes the connection.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Device code</p>
                <p
                  className="mt-1 font-mono text-2xl font-semibold tracking-normal"
                  data-testid="codex-device-auth-code"
                >
                  {flow.verificationCode}
                </p>
              </div>
              <CopyButton
                type="button"
                text={flow.verificationCode}
                className="-m-1 p-1.5 hover:bg-accent"
              />
            </div>
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
          {statusText && (
            <p className="text-xs text-muted-foreground" role="status">
              {statusText}
            </p>
          )}
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

function CodexDeviceAuthLoadingContent() {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
      data-testid="codex-device-auth-loading"
    >
      <IconLoader2 size={16} className="animate-spin" />
      <span>Preparing...</span>
    </div>
  );
}

function CodexDeviceAuthStartButton({
  mode,
  onStart,
}: {
  mode: "connect" | "reconnect";
  onStart: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onStart}
      className="w-full gap-2"
      data-testid="codex-device-auth-start"
    >
      {mode === "reconnect" ? "Reconnect ChatGPT" : "Sign in with ChatGPT"}
    </Button>
  );
}

function codexDeviceAuthStatusText(
  flow: Extract<CodexDeviceAuthFlowState, { status: "pending" | "polling" }>,
): string | null {
  if (!flow.approvalOpened && !flow.codeCopied) {
    return null;
  }
  if (flow.codeCopied && !flow.approvalOpened) {
    return "Device code copied. Try opening the approval page again.";
  }
  if (!flow.codeCopied) {
    return "Approval page opened. Copy the device code before approving.";
  }
  return "Device code copied. Waiting for approval...";
}
