import { Button, Input } from "@okouai/ui";
import type { Computed } from "ccstate";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import type { AuthV2ContinuationSignals } from "../../../signals/auth-v2/continuation.ts";
import type {
  AuthV2SecurityTaskAction,
  AuthV2SecurityTaskState,
} from "../../../signals/auth-v2/continuation-security.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { AuthV2ErrorAlert } from "../auth-v2-error-alert.tsx";
import { AuthV2SubmitButton } from "../auth-v2-submit-button.tsx";
import {
  useAuthV2SignInCopy,
  type AuthV2SignInCopy,
} from "../sign-in/sign-in-copy.ts";
import type { AuthV2ContinuationCopy } from "./continuation-copy.ts";

type MfaState = Extract<AuthV2SecurityTaskState, { task: "setup-mfa" }>;
interface SecurityStepProps {
  readonly copy: AuthV2ContinuationCopy;
  readonly signInCopy: AuthV2SignInCopy;
  readonly busy: boolean;
  readonly run: (action: AuthV2SecurityTaskAction) => void;
}

function fieldValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function PasswordResetStep({
  copy,
  signInCopy,
  busy,
  run,
  updated,
}: SecurityStepProps & { readonly updated: boolean }) {
  if (updated) {
    return (
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          run({ action: "finish" });
        }}
      >
        <p className="text-sm text-muted-foreground">{copy.taskComplete}</p>
        <AuthV2SubmitButton busy={busy} label={signInCopy.continue} />
      </form>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        run({
          action: "reset-password",
          password: fieldValue(form, "password"),
          confirmation: fieldValue(form, "confirmation"),
        });
      }}
    >
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="task-password">
          {signInCopy.newPasswordLabel}
        </label>
        <Input
          id="task-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          disabled={busy}
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="task-confirmation">
          {signInCopy.confirmPasswordLabel}
        </label>
        <Input
          id="task-confirmation"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          required
          disabled={busy}
        />
      </div>
      <AuthV2SubmitButton busy={busy} label={signInCopy.resetPassword} />
    </form>
  );
}

function BackupCodesStep({
  copy,
  signInCopy,
  busy,
  run,
  codes,
}: SecurityStepProps & { readonly codes: readonly string[] }) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        run({ action: "finish" });
      }}
    >
      {codes.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">
            {copy.backupDescription}
          </p>
          <ul
            aria-label={copy.backupTitle}
            className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 font-mono text-sm"
          >
            {codes.map((code) => {
              return <li key={code}>{code}</li>;
            })}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.taskComplete}</p>
      )}
      <AuthV2SubmitButton
        busy={busy}
        label={codes.length ? copy.savedCodes : signInCopy.continue}
      />
    </form>
  );
}

function MfaVerificationStep({
  copy,
  signInCopy,
  busy,
  run,
  state,
}: SecurityStepProps & { readonly state: MfaState }) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        run({
          action: "verify",
          code: fieldValue(new FormData(event.currentTarget), "code"),
        });
      }}
    >
      {state.secret ? (
        <>
          <p className="text-sm text-muted-foreground">
            {copy.setupKeyDescription}
          </p>
          <code
            aria-label={copy.setupKey}
            className="block break-all rounded-md border border-border p-3 text-sm select-all"
          >
            {state.secret}
          </code>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {signInCopy.phoneCodeSubtitle}
        </p>
      )}
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="task-code">
          {signInCopy.codeLabel}
        </label>
        <Input
          id="task-code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          required
          disabled={busy}
        />
      </div>
      <AuthV2SubmitButton busy={busy} label={signInCopy.verify} />
      {state.phoneNumber ? (
        <Button
          className="w-full"
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            run({
              action: "prepare-phone",
              phoneNumber: state.phoneNumber ?? "",
            });
          }}
        >
          {signInCopy.resendCode}
        </Button>
      ) : null}
    </form>
  );
}

function MfaSetupStep(props: SecurityStepProps & { readonly state: MfaState }) {
  const { copy, signInCopy, busy, run, state } = props;
  if (state.backupCodes !== null) {
    return <BackupCodesStep {...props} codes={state.backupCodes} />;
  }
  return (
    <>
      {state.secret || state.phoneNumber ? (
        <MfaVerificationStep {...props} />
      ) : null}
      {state.methods.includes("totp") && !state.secret ? (
        <Button
          className="w-full"
          variant="outline"
          disabled={busy}
          onClick={() => {
            run({ action: "prepare-totp" });
          }}
        >
          {signInCopy.authenticatorMethod}
        </Button>
      ) : null}
      {state.methods.includes("phone_code") && !state.phoneNumber ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run({
              action: "prepare-phone",
              phoneNumber: fieldValue(
                new FormData(event.currentTarget),
                "phoneNumber",
              ),
            });
          }}
        >
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="task-phone">
              {copy.phoneNumberLabel}
            </label>
            <Input
              id="task-phone"
              name="phoneNumber"
              type="tel"
              autoComplete="tel"
              placeholder="+1 555 555 0123"
              required
              disabled={busy}
            />
          </div>
          <AuthV2SubmitButton busy={busy} label={copy.sendCode} />
        </form>
      ) : null}
    </>
  );
}

export function AuthV2SecurityTaskContent({
  copy,
  operationSignal$,
  signals,
  state,
}: {
  readonly copy: AuthV2ContinuationCopy;
  readonly operationSignal$: Computed<AbortSignal>;
  readonly signals: AuthV2ContinuationSignals;
  readonly state: AuthV2SecurityTaskState;
}) {
  const signInCopy = useAuthV2SignInCopy();
  const signal = useGet(operationSignal$);
  const [loadable, submit] = useLoadableSet(signals.submitSecurityTask$);
  const busy = loadable.state === "loading";
  const run = (action: AuthV2SecurityTaskAction) => {
    detach(
      submit(action, signal),
      Reason.DomCallback,
      "complete authentication security task",
    );
  };
  const error =
    state.error === "password-mismatch"
      ? signInCopy.passwordMismatch
      : state.error === "password-invalid"
        ? copy.passwordTaskError
        : copy.taskError;
  return (
    <div className="space-y-4">
      {state.error ? (
        <AuthV2ErrorAlert focusKey={state.error} message={error} />
      ) : null}
      {state.task === "reset-password" ? (
        <PasswordResetStep
          copy={copy}
          signInCopy={signInCopy}
          busy={busy}
          run={run}
          updated={state.updated}
        />
      ) : (
        <MfaSetupStep
          copy={copy}
          signInCopy={signInCopy}
          busy={busy}
          run={run}
          state={state}
        />
      )}
    </div>
  );
}
