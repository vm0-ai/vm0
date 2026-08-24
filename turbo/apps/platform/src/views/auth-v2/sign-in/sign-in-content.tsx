import { Button, Input } from "@okouai/ui";
import { Alert, AlertDescription } from "@okouai/ui/components/ui/alert";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import type { FormEvent } from "react";

import type {
  AuthV2SignInSignals,
  AuthV2SignInState,
} from "../../../signals/auth-v2/sign-in-flow.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { Link } from "../../router/link.tsx";
import {
  type AuthV2SignInCopy,
  signInErrorMessage,
  signInFactorLabel,
} from "./sign-in-copy.ts";

type IncompleteSignInState = Extract<
  AuthV2SignInState,
  { status: "incomplete" }
>;

interface SignInStepProps {
  readonly copy: AuthV2SignInCopy;
  readonly signals: AuthV2SignInSignals;
}

function TextField({
  autoComplete,
  inputMode,
  label,
  name,
  onChange,
  type = "text",
  value,
}: {
  readonly autoComplete: string;
  readonly inputMode?: "email" | "numeric";
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly type?: "password" | "text";
  readonly value: string;
}) {
  const id = `auth-v2-${name}`;
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        name={name}
        autoComplete={autoComplete}
        inputMode={inputMode}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        required
        type={type}
        value={value}
      />
    </div>
  );
}

function FlowErrorAlert({ copy, signals }: SignInStepProps) {
  const error = useGet(signals.error$);
  if (!error) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>{signInErrorMessage(error, copy)}</AlertDescription>
    </Alert>
  );
}

function SubmitButton({
  busy,
  disabled = busy,
  label,
}: {
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly label: string;
}) {
  return (
    <Button className="w-full" disabled={disabled} type="submit">
      {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}

function IdentifierStep({ copy, signals }: SignInStepProps) {
  const identifier = useGet(signals.identifier$);
  const pageSignal = useGet(pageSignal$);
  const setIdentifier = useSet(signals.setIdentifier$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert copy={copy} signals={signals} />
      <TextField
        autoComplete="username"
        inputMode="email"
        label={copy.identifierLabel}
        name="identifier"
        onChange={setIdentifier}
        value={identifier}
      />
      <SubmitButton
        busy={submitLoadable.state === "loading"}
        label={copy.continue}
      />
    </form>
  );
}

function ChooseFactorStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const pageSignal = useGet(pageSignal$);
  const backToIdentifier = useSet(signals.backToIdentifier$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const handleSelectFactor = (factorId: string): void => {
    detach(
      selectFactor(factorId, pageSignal),
      Reason.DomCallback,
      "select auth v2 sign in factor",
    );
  };
  return (
    <div className="space-y-4">
      <FlowErrorAlert copy={copy} signals={signals} />
      <h2 className="text-base font-medium text-foreground">
        {copy.chooseMethodTitle}
      </h2>
      <div className="space-y-2">
        {state.factors.map((factor) => {
          return (
            <Button
              className="w-full justify-start"
              disabled={selectLoadable.state === "loading"}
              key={factor.id}
              type="button"
              variant="outline"
              onClick={() => {
                handleSelectFactor(factor.id);
              }}
            >
              {signInFactorLabel(factor, copy)}
            </Button>
          );
        })}
      </div>
      <Button
        className="w-full"
        type="button"
        variant="ghost"
        onClick={backToIdentifier}
      >
        {copy.editIdentifier}
      </Button>
    </div>
  );
}

function PasswordStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const password = useGet(signals.password$);
  const pageSignal = useGet(pageSignal$);
  const setPassword = useSet(signals.setPassword$);
  const backToMethods = useSet(signals.backToMethods$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const resetFactor = state.factors.find((factor) => {
    return factor.kind === "password-reset";
  });
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  const handleReset = (): void => {
    if (!resetFactor) {
      return;
    }
    detach(
      selectFactor(resetFactor.id, pageSignal),
      Reason.DomCallback,
      "select auth v2 password reset",
    );
  };
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert copy={copy} signals={signals} />
      <h2 className="text-base font-medium text-foreground">
        {copy.passwordTitle}
      </h2>
      <TextField
        autoComplete="current-password"
        label={copy.passwordLabel}
        name="password"
        onChange={setPassword}
        type="password"
        value={password}
      />
      {resetFactor ? (
        <Button
          className="h-auto p-0"
          disabled={selectLoadable.state === "loading"}
          type="button"
          variant="link"
          onClick={handleReset}
        >
          {copy.forgotPassword}
        </Button>
      ) : null}
      <SubmitButton
        busy={submitLoadable.state === "loading"}
        label={copy.continue}
      />
      <Button
        className="w-full"
        type="button"
        variant="ghost"
        onClick={backToMethods}
      >
        {copy.useAnotherMethod}
      </Button>
    </form>
  );
}

function CodeStep({
  copy,
  reset,
  signals,
  state,
}: SignInStepProps & {
  readonly reset: boolean;
  readonly state: IncompleteSignInState;
}) {
  const code = useGet(signals.code$);
  const pageSignal = useGet(pageSignal$);
  const setCode = useSet(signals.setCode$);
  const backToMethods = useSet(signals.backToMethods$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [resendLoadable, resendCode] = useLoadableSet(signals.resendCode$);
  const submitting = submitLoadable.state === "loading";
  const resending = resendLoadable.state === "loading";
  const operationPending = submitting || resending;
  const selectedFactor = state.selectedFactor;
  const safeIdentifier =
    selectedFactor && selectedFactor.kind !== "password"
      ? selectedFactor.safeIdentifier
      : null;
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  const handleResend = (): void => {
    detach(
      resendCode(pageSignal),
      Reason.DomCallback,
      "resend auth v2 sign in code",
    );
  };
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert copy={copy} signals={signals} />
      <h2 className="text-base font-medium text-foreground">
        {reset ? copy.resetPasswordCodeTitle : copy.emailCodeTitle}
      </h2>
      {safeIdentifier ? (
        <p className="text-sm text-muted-foreground">{safeIdentifier}</p>
      ) : null}
      <TextField
        autoComplete="one-time-code"
        inputMode="numeric"
        label={copy.codeLabel}
        name="code"
        onChange={setCode}
        value={code}
      />
      <SubmitButton
        busy={submitting}
        disabled={operationPending}
        label={copy.verify}
      />
      <Button
        className="h-auto w-full"
        disabled={operationPending}
        type="button"
        variant="link"
        onClick={handleResend}
      >
        {resending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : null}
        {copy.resendCode}
      </Button>
      <Button
        className="w-full"
        type="button"
        variant="ghost"
        onClick={backToMethods}
      >
        {copy.back}
      </Button>
    </form>
  );
}

function NewPasswordStep({ copy, signals }: SignInStepProps) {
  const newPassword = useGet(signals.newPassword$);
  const confirmPassword = useGet(signals.confirmPassword$);
  const pageSignal = useGet(pageSignal$);
  const setNewPassword = useSet(signals.setNewPassword$);
  const setConfirmPassword = useSet(signals.setConfirmPassword$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert copy={copy} signals={signals} />
      <h2 className="text-base font-medium text-foreground">
        {copy.newPasswordTitle}
      </h2>
      <TextField
        autoComplete="new-password"
        label={copy.newPasswordLabel}
        name="new-password"
        onChange={setNewPassword}
        type="password"
        value={newPassword}
      />
      <TextField
        autoComplete="new-password"
        label={copy.confirmPasswordLabel}
        name="confirm-password"
        onChange={setConfirmPassword}
        type="password"
        value={confirmPassword}
      />
      <SubmitButton
        busy={submitLoadable.state === "loading"}
        label={copy.resetPassword}
      />
    </form>
  );
}

function LoadingStep({ copy }: { readonly copy: AuthV2SignInCopy }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="animate-spin" aria-hidden="true" />
      <span>{copy.loading}</span>
    </div>
  );
}

function CompleteStep({ copy }: { readonly copy: AuthV2SignInCopy }) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-8 text-center"
      role="status"
    >
      <Loader2
        className="animate-spin text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="text-base font-medium text-foreground">
        {copy.completeTitle}
      </h2>
    </div>
  );
}

function TransferStep({ copy, signals }: SignInStepProps) {
  const restart = useSet(signals.restart$);
  return (
    <div className="space-y-3">
      <Button className="w-full" asChild>
        <Link pathname={ROUTES.signUpV2}>{copy.signUp}</Link>
      </Button>
      <Button
        className="w-full"
        type="button"
        variant="ghost"
        onClick={restart}
      >
        {copy.useAnotherMethod}
      </Button>
    </div>
  );
}

function UnknownStep({ copy, signals }: SignInStepProps) {
  const restart = useSet(signals.restart$);
  return (
    <div className="space-y-4 text-center">
      <h2 className="text-base font-medium text-foreground">
        {copy.noMethodsTitle}
      </h2>
      <Button
        className="w-full"
        type="button"
        variant="outline"
        onClick={restart}
      >
        {copy.useAnotherMethod}
      </Button>
    </div>
  );
}

export function SignInCardContent({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: AuthV2SignInState }) {
  if (state.status === "loading") {
    return <LoadingStep copy={copy} />;
  }
  if (state.status === "complete") {
    return <CompleteStep copy={copy} />;
  }
  if (state.status === "transfer") {
    return <TransferStep copy={copy} signals={signals} />;
  }
  if (state.status === "unknown") {
    return <UnknownStep copy={copy} signals={signals} />;
  }
  if (state.step === "identifier") {
    return <IdentifierStep copy={copy} signals={signals} />;
  }
  if (state.step === "choose-factor") {
    return <ChooseFactorStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "password") {
    return <PasswordStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "email-code") {
    return (
      <CodeStep copy={copy} reset={false} signals={signals} state={state} />
    );
  }
  if (state.step === "password-reset-code") {
    return <CodeStep copy={copy} reset signals={signals} state={state} />;
  }
  return <NewPasswordStep copy={copy} signals={signals} />;
}
