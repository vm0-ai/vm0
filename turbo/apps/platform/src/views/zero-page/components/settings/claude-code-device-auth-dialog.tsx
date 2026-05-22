import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { IconLoader2 } from "@tabler/icons-react";

import {
  claudeCodeDeviceAuthDialogState$,
  claudeCodeDeviceAuthDialogStatePersonal$,
  claudeCodeDeviceAuthAutoStartRef$,
  claudeCodeDeviceAuthAutoStartRefPersonal$,
  claudeCodeDeviceAuthFlowState$,
  claudeCodeDeviceAuthFlowStatePersonal$,
  closeClaudeCodeDeviceAuthDialog$,
  closeClaudeCodeDeviceAuthDialogPersonal$,
  openClaudeCodeDeviceAuthApprovalPage$,
  openClaudeCodeDeviceAuthApprovalPagePersonal$,
  runClaudeCodeDeviceAuth$,
  runClaudeCodeDeviceAuthPersonal$,
  setClaudeCodeDeviceAuthAuthorizationCode$,
  setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  setClaudeCodeDeviceAuthDialogState$,
  setClaudeCodeDeviceAuthDialogStatePersonal$,
  submitClaudeCodeDeviceAuth$,
  submitClaudeCodeDeviceAuthPersonal$,
  type ClaudeCodeDeviceAuthFlowState,
} from "../../../../signals/zero-page/settings/claude-code-device-auth.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ProviderIcon } from "./provider-icons.tsx";

type ClaudeCodeDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

type AutoStartRef = (element: HTMLDivElement | null) => void;

interface ClaudeCodeDeviceAuthScopeBundle {
  dialog: ClaudeCodeDeviceAuthDialogState;
  flow: ClaudeCodeDeviceAuthFlowState;
  autoStartRef: AutoStartRef;
  setDialog: (next: ClaudeCodeDeviceAuthDialogState) => void;
  close: (signal: AbortSignal) => Promise<void>;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  run: (signal: AbortSignal) => Promise<boolean>;
  submit: (signal: AbortSignal) => Promise<boolean>;
  setAuthorizationCode: (value: string) => void;
}

export function ClaudeCodeDeviceAuthDialog() {
  const bundle = useOrgClaudeCodeDeviceAuthBundle();
  return <ClaudeCodeDeviceAuthDialogView bundle={bundle} />;
}

export function PersonalClaudeCodeDeviceAuthDialog() {
  const bundle = usePersonalClaudeCodeDeviceAuthBundle();
  return <ClaudeCodeDeviceAuthDialogView bundle={bundle} />;
}

function useOrgClaudeCodeDeviceAuthBundle(): ClaudeCodeDeviceAuthScopeBundle {
  const dialog = useGet(claudeCodeDeviceAuthDialogState$);
  const flow = useGet(claudeCodeDeviceAuthFlowState$);
  const autoStartRef = useSet(claudeCodeDeviceAuthAutoStartRef$);
  const setDialog = useSet(setClaudeCodeDeviceAuthDialogState$);
  const close = useSet(closeClaudeCodeDeviceAuthDialog$);
  const openApprovalPage = useSet(openClaudeCodeDeviceAuthApprovalPage$);
  const [, run] = useLoadableSet(runClaudeCodeDeviceAuth$);
  const [, submit] = useLoadableSet(submitClaudeCodeDeviceAuth$);
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCode$,
  );
  return {
    dialog,
    flow,
    autoStartRef,
    setDialog,
    close,
    openApprovalPage,
    run,
    submit,
    setAuthorizationCode,
  };
}

function usePersonalClaudeCodeDeviceAuthBundle(): ClaudeCodeDeviceAuthScopeBundle {
  const dialog = useGet(claudeCodeDeviceAuthDialogStatePersonal$);
  const flow = useGet(claudeCodeDeviceAuthFlowStatePersonal$);
  const autoStartRef = useSet(claudeCodeDeviceAuthAutoStartRefPersonal$);
  const setDialog = useSet(setClaudeCodeDeviceAuthDialogStatePersonal$);
  const close = useSet(closeClaudeCodeDeviceAuthDialogPersonal$);
  const openApprovalPage = useSet(
    openClaudeCodeDeviceAuthApprovalPagePersonal$,
  );
  const [, run] = useLoadableSet(runClaudeCodeDeviceAuthPersonal$);
  const [, submit] = useLoadableSet(submitClaudeCodeDeviceAuthPersonal$);
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  );
  return {
    dialog,
    flow,
    autoStartRef,
    setDialog,
    close,
    openApprovalPage,
    run,
    submit,
    setAuthorizationCode,
  };
}

function ClaudeCodeDeviceAuthDialogView({
  bundle,
}: {
  bundle: ClaudeCodeDeviceAuthScopeBundle;
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
    submit,
    setAuthorizationCode,
  } = bundle;
  const title =
    dialog.mode === "reconnect"
      ? "Re-connect Claude Code"
      : "Connect Claude Code";

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

  function handleSubmit(): void {
    detach(submit(pageSignal), Reason.DomCallback);
  }

  return (
    <Dialog open={dialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <div ref={autoStartRef} className="contents">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                <ProviderIcon type="claude-code-oauth-token" size={20} />
              </div>
              <DialogTitle>{title}</DialogTitle>
            </div>
          </DialogHeader>

          <ClaudeCodeDeviceAuthBody
            flow={flow}
            mode={dialog.mode}
            onStart={handleStart}
            onSubmit={handleSubmit}
            openApprovalPage={openApprovalPage}
            pageSignal={pageSignal}
            setAuthorizationCode={setAuthorizationCode}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ClaudeCodeDeviceAuthBody({
  flow,
  mode,
  onStart,
  onSubmit,
  openApprovalPage,
  pageSignal,
  setAuthorizationCode,
}: {
  flow: ClaudeCodeDeviceAuthFlowState;
  mode: "connect" | "reconnect";
  onStart: () => void;
  onSubmit: () => void;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  pageSignal: AbortSignal;
  setAuthorizationCode: (value: string) => void;
}) {
  switch (flow.status) {
    case "idle": {
      return <ClaudeCodeDeviceAuthLoadingContent />;
    }
    case "starting": {
      return <ClaudeCodeDeviceAuthLoadingContent />;
    }
    case "pending":
    case "submitting": {
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            <p>
              First click Open Claude approval page. Then approve vm0 in Claude
              and copy the authorization code shown after approval. Finally
              paste that code here and click Connect.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              detach(openApprovalPage(pageSignal), Reason.DomCallback);
            }}
            data-testid="claude-code-device-auth-open"
          >
            Open Claude approval page
          </Button>
          <div className="flex flex-col gap-2">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="claude-code-device-auth-code"
            >
              Authorization code
            </label>
            <Input
              id="claude-code-device-auth-code"
              value={flow.authorizationCode}
              placeholder="Paste code from Claude"
              readOnly={flow.status === "submitting"}
              onChange={(event) => {
                setAuthorizationCode(event.target.value);
              }}
              data-testid="claude-code-device-auth-code"
            />
          </div>
          {flow.errorMessage && (
            <p className="text-xs text-destructive" role="alert">
              {flow.errorMessage}
            </p>
          )}
          <Button
            type="button"
            className="w-full gap-2"
            onClick={onSubmit}
            disabled={flow.status === "submitting"}
            data-testid="claude-code-device-auth-submit"
          >
            {flow.status === "submitting" && (
              <IconLoader2 size={14} className="animate-spin" />
            )}
            {flow.status === "submitting" ? "Connecting..." : "Connect"}
          </Button>
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
          <ClaudeCodeDeviceAuthStartButton mode={mode} onStart={onStart} />
        </div>
      );
    }
  }
}

function ClaudeCodeDeviceAuthLoadingContent() {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
      data-testid="claude-code-device-auth-loading"
    >
      <IconLoader2 size={16} className="animate-spin" />
      <span>Preparing...</span>
    </div>
  );
}

function ClaudeCodeDeviceAuthStartButton({
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
      data-testid="claude-code-device-auth-start"
    >
      {mode === "reconnect" ? "Reconnect Claude Code" : "Sign in with Claude"}
    </Button>
  );
}
