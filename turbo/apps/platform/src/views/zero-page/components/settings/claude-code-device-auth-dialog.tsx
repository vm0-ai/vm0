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
import { ConnectorHelpText } from "./connector-help-text.tsx";
import { ProviderIcon } from "./provider-icons.tsx";

type ClaudeCodeDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

interface ClaudeCodeDeviceAuthScopeBundle {
  dialog: ClaudeCodeDeviceAuthDialogState;
  flow: ClaudeCodeDeviceAuthFlowState;
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
      return <ClaudeCodeDeviceAuthStartContent mode={mode} onStart={onStart} />;
    }
    case "starting": {
      return (
        <ClaudeCodeDeviceAuthStartContent
          mode={mode}
          onStart={onStart}
          loading
        />
      );
    }
    case "pending":
    case "submitting": {
      return (
        <div className="space-y-3">
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
          <p className="text-xs text-muted-foreground" role="status">
            {claudeCodeDeviceAuthStatusText(flow)}
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
          <ClaudeCodeDeviceAuthStartButton mode={mode} onStart={onStart} />
        </div>
      );
    }
  }
}

function ClaudeCodeDeviceAuthStartContent({
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
      <ConnectorHelpText text="vm0 will start a short-lived Claude Code login session. After approval, paste the one-time code shown by Claude." />
      <ClaudeCodeDeviceAuthStartButton
        mode={mode}
        onStart={onStart}
        loading={loading}
      />
    </div>
  );
}

function ClaudeCodeDeviceAuthStartButton({
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
      data-testid="claude-code-device-auth-start"
    >
      {loading && <IconLoader2 size={14} className="animate-spin" />}
      {loading
        ? "Preparing..."
        : mode === "reconnect"
          ? "Reconnect Claude Code"
          : "Sign in with Claude"}
    </Button>
  );
}

function claudeCodeDeviceAuthStatusText(
  flow: Extract<
    ClaudeCodeDeviceAuthFlowState,
    { status: "pending" | "submitting" }
  >,
): string {
  if (flow.status === "submitting") {
    return "Checking connection...";
  }
  if (!flow.approvalOpened) {
    return "Open the approval page to continue.";
  }
  return "Paste the code shown after approval.";
}
