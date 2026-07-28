import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
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
  submitClaudeCodeDeviceAuth$,
  submitClaudeCodeDeviceAuthPersonal$,
  type ClaudeCodeDeviceAuthFlowState,
} from "../../../../signals/zero-page/settings/claude-code-device-auth.ts";
import { brandName$ } from "../../../../signals/branding.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ProviderIcon } from "./provider-icons.tsx";

type ClaudeCodeDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

interface ClaudeCodeDeviceAuthScopeBundle {
  dialog: ClaudeCodeDeviceAuthDialogState;
  flow: ClaudeCodeDeviceAuthFlowState;
  close: (signal: AbortSignal) => Promise<void>;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  run: (signal: AbortSignal) => Promise<boolean>;
  submit: (signal: AbortSignal) => Promise<boolean>;
  submitting: boolean;
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
  const close = useSet(closeClaudeCodeDeviceAuthDialog$);
  const openApprovalPage = useSet(openClaudeCodeDeviceAuthApprovalPage$);
  const [, run] = useLoadableSet(runClaudeCodeDeviceAuth$);
  const [submitLoadable, submit] = useLoadableSet(submitClaudeCodeDeviceAuth$);
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCode$,
  );
  return {
    dialog,
    flow,
    close,
    openApprovalPage,
    run,
    submit,
    submitting: submitLoadable.state === "loading",
    setAuthorizationCode,
  };
}

function usePersonalClaudeCodeDeviceAuthBundle(): ClaudeCodeDeviceAuthScopeBundle {
  const dialog = useGet(claudeCodeDeviceAuthDialogStatePersonal$);
  const flow = useGet(claudeCodeDeviceAuthFlowStatePersonal$);
  const close = useSet(closeClaudeCodeDeviceAuthDialogPersonal$);
  const openApprovalPage = useSet(
    openClaudeCodeDeviceAuthApprovalPagePersonal$,
  );
  const [, run] = useLoadableSet(runClaudeCodeDeviceAuthPersonal$);
  const [submitLoadable, submit] = useLoadableSet(
    submitClaudeCodeDeviceAuthPersonal$,
  );
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  );
  return {
    dialog,
    flow,
    close,
    openApprovalPage,
    run,
    submit,
    submitting: submitLoadable.state === "loading",
    setAuthorizationCode,
  };
}

function ClaudeCodeDeviceAuthDialogView({
  bundle,
}: {
  bundle: ClaudeCodeDeviceAuthScopeBundle;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const {
    dialog,
    flow,
    close,
    openApprovalPage,
    run,
    submit,
    submitting,
    setAuthorizationCode,
  } = bundle;
  const title =
    dialog.mode === "reconnect"
      ? t(($) => {
          return $.settings.models.deviceAuth.claude.reconnectTitle;
        })
      : t(($) => {
          return $.settings.models.deviceAuth.claude.connectTitle;
        });

  function handleOpenChange(nextOpen: boolean): void {
    if (nextOpen) {
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
          submitting={submitting}
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
  submitting,
}: {
  flow: ClaudeCodeDeviceAuthFlowState;
  mode: "connect" | "reconnect";
  onStart: () => void;
  onSubmit: () => void;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  pageSignal: AbortSignal;
  setAuthorizationCode: (value: string) => void;
  submitting: boolean;
}) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  switch (flow.status) {
    case "idle": {
      return <ClaudeCodeDeviceAuthLoadingContent />;
    }
    case "starting": {
      return <ClaudeCodeDeviceAuthLoadingContent />;
    }
    case "pending": {
      return (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            <p>
              {t(
                ($) => {
                  return $.settings.models.deviceAuth.claude.instructions;
                },
                { brandName },
              )}
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
            {t(($) => {
              return $.settings.models.deviceAuth.claude.openApproval;
            })}
          </Button>
          <div className="flex flex-col gap-2">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="claude-code-device-auth-code"
            >
              {t(($) => {
                return $.settings.models.deviceAuth.claude.authorizationCode;
              })}
            </label>
            <Input
              id="claude-code-device-auth-code"
              value={flow.authorizationCode}
              placeholder={t(($) => {
                return $.settings.models.deviceAuth.claude.codePlaceholder;
              })}
              readOnly={submitting}
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
            type="submit"
            className="w-full gap-2"
            disabled={submitting}
            data-testid="claude-code-device-auth-submit"
          >
            {submitting && <IconLoader2 size={14} className="animate-spin" />}
            {submitting
              ? t(($) => {
                  return $.settings.shared.connecting;
                })
              : t(($) => {
                  return $.settings.models.deviceAuth.claude.submit;
                })}
          </Button>
        </form>
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
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
      data-testid="claude-code-device-auth-loading"
    >
      <IconLoader2 size={16} className="animate-spin" />
      <span>
        {t(($) => {
          return $.settings.models.deviceAuth.claude.preparing;
        })}
      </span>
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
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onStart}
      className="w-full gap-2"
      data-testid="claude-code-device-auth-start"
    >
      {mode === "reconnect"
        ? t(($) => {
            return $.settings.models.deviceAuth.claude.reconnectAction;
          })
        : t(($) => {
            return $.settings.models.deviceAuth.claude.signIn;
          })}
    </Button>
  );
}
