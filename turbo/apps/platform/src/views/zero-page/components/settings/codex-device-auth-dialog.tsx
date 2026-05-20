import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";

import {
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
import { setCodexPasteDialogState$ } from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { setCodexPasteDialogStatePersonal$ } from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

type CodexDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

type RunLoadable = ReturnType<typeof useLoadableSet<boolean, [AbortSignal]>>[0];

interface CodexDeviceAuthScopeBundle {
  dialog: CodexDeviceAuthDialogState;
  flow: CodexDeviceAuthFlowState;
  setDialog: (next: CodexDeviceAuthDialogState) => void;
  openApprovalPage: () => boolean;
  openPasteFallback: (mode: "connect" | "reconnect") => void;
  runLoadable: RunLoadable;
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
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPage$);
  const setPasteDialog = useSet(setCodexPasteDialogState$);
  const [runLoadable, run] = useLoadableSet(runCodexDeviceAuth$);
  return {
    dialog,
    flow,
    setDialog,
    openApprovalPage,
    openPasteFallback: (mode) => {
      setDialog({ open: false, mode });
      setPasteDialog({ open: true, mode });
    },
    runLoadable,
    run,
  };
}

function usePersonalCodexDeviceAuthBundle(): CodexDeviceAuthScopeBundle {
  const dialog = useGet(codexDeviceAuthDialogStatePersonal$);
  const flow = useGet(codexDeviceAuthFlowStatePersonal$);
  const setDialog = useSet(setCodexDeviceAuthDialogStatePersonal$);
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPagePersonal$);
  const setPasteDialog = useSet(setCodexPasteDialogStatePersonal$);
  const [runLoadable, run] = useLoadableSet(runCodexDeviceAuthPersonal$);
  return {
    dialog,
    flow,
    setDialog,
    openApprovalPage,
    openPasteFallback: (mode) => {
      setDialog({ open: false, mode });
      setPasteDialog({ open: true, mode });
    },
    runLoadable,
    run,
  };
}

function CodexDeviceAuthDialogView({
  bundle,
}: {
  bundle: CodexDeviceAuthScopeBundle;
}) {
  const pageSignal = useGet(pageSignal$);
  const { dialog, flow, setDialog, openApprovalPage, openPasteFallback, run } =
    bundle;
  const title =
    dialog.mode === "reconnect" ? "Re-connect Codex" : "Connect Codex";
  const startDisabled = flow.status === "starting" || flow.status === "polling";
  const showStart =
    flow.status === "idle" ||
    flow.status === "error" ||
    flow.status === "expired";

  function handleOpenChange(nextOpen: boolean): void {
    setDialog({ ...dialog, open: nextOpen });
  }

  return (
    <Dialog open={dialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Sign in with the official Codex device flow. Keep this dialog open
            while you approve access in your browser.
          </DialogDescription>
        </DialogHeader>

        <CodexDeviceAuthBody flow={flow} openApprovalPage={openApprovalPage} />

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={() => {
              openPasteFallback(dialog.mode);
            }}
            disabled={flow.status === "starting" || flow.status === "polling"}
          >
            Use auth.json instead
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              return handleOpenChange(false);
            }}
          >
            Cancel
          </Button>
          {showStart && (
            <Button
              onClick={() => {
                detach(run(pageSignal), Reason.DomCallback);
              }}
              disabled={startDisabled}
              data-testid="codex-device-auth-start"
            >
              {dialog.mode === "reconnect" ? "Reconnect" : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CodexDeviceAuthBody({
  flow,
  openApprovalPage,
}: {
  flow: CodexDeviceAuthFlowState;
  openApprovalPage: () => boolean;
}) {
  switch (flow.status) {
    case "idle": {
      return (
        <p className="text-sm text-muted-foreground">
          vm0 will start a short-lived sandbox, get a Codex device code, then
          open the approval page.
        </p>
      );
    }
    case "starting": {
      return (
        <p className="text-sm text-muted-foreground" role="status">
          Preparing Codex login…
        </p>
      );
    }
    case "pending":
    case "polling": {
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Device code</p>
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
            onClick={openApprovalPage}
            data-testid="codex-device-auth-open"
          >
            Open approval page
          </Button>
          <p className="text-xs text-muted-foreground" role="status">
            Waiting for Codex approval…
          </p>
        </div>
      );
    }
    case "expired":
    case "error": {
      return (
        <p className="text-sm text-destructive" role="alert">
          {flow.message}
        </p>
      );
    }
  }
}
