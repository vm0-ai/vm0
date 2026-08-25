import { Button, cn, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import type {
  AuthV2SignInError,
  AuthV2SignInErrorField,
  AuthV2SignInSignals,
  AuthV2SignInState,
} from "../../../signals/auth-v2/sign-in-flow.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { Link } from "../../router/link.tsx";
import { AuthV2Divider } from "../auth-v2-divider.tsx";
import { AuthV2ErrorAlert } from "../auth-v2-error-alert.tsx";
import { AuthV2FieldError } from "../auth-v2-field-error.tsx";
import { AuthV2OAuthIcon } from "../auth-v2-oauth-icon.tsx";
import { AuthV2OtpInput } from "../auth-v2-otp-input.tsx";
import { AuthV2PasswordInput } from "../auth-v2-password-input.tsx";
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

const AUTH_V2_SIGN_IN_ERROR_ID = "auth-v2-sign-in-error";

function TextField({
  autoComplete,
  copy,
  error,
  inputMode,
  label,
  name,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  readonly autoComplete: string;
  readonly copy: AuthV2SignInCopy;
  readonly error: AuthV2SignInError | null;
  readonly inputMode?: "email" | "numeric";
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: "password" | "text";
  readonly value: string;
}) {
  const id = `auth-v2-${name}`;
  const invalid = error !== null;
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        aria-describedby={invalid ? AUTH_V2_SIGN_IN_ERROR_ID : undefined}
        aria-invalid={invalid ? true : undefined}
        id={id}
        name={name}
        autoComplete={autoComplete}
        inputMode={inputMode}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        placeholder={placeholder}
        required
        type={type}
        value={value}
      />
      {error ? (
        <AuthV2FieldError
          focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
          id={AUTH_V2_SIGN_IN_ERROR_ID}
          message={signInErrorMessage(error, copy)}
        />
      ) : null}
    </div>
  );
}

function FlowErrorAlert({
  copy,
  handledFields = [],
  signals,
}: SignInStepProps & {
  readonly handledFields?: readonly AuthV2SignInErrorField[];
}) {
  const error = useGet(signals.error$);
  if (!error || handledFields.includes(error.field)) {
    return null;
  }
  return (
    <AuthV2ErrorAlert
      focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
      id={AUTH_V2_SIGN_IN_ERROR_ID}
      message={signInErrorMessage(error, copy)}
    />
  );
}

function signUpLinkOptions(signUpHref: string) {
  const url = new URL(signUpHref, location.origin);
  return {
    hash: url.hash,
    searchParams: url.searchParams,
  };
}

function SignUpLink({
  children,
  className,
  signUpHref,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly signUpHref: string;
}) {
  return (
    <Link
      className={className}
      options={signUpLinkOptions(signUpHref)}
      pathname={ROUTES.signUpV2}
    >
      {children}
    </Link>
  );
}

function PasswordField({
  autoComplete,
  copy,
  error,
  label,
  name,
  onChange,
  value,
}: {
  readonly autoComplete: string;
  readonly copy: AuthV2SignInCopy;
  readonly error: AuthV2SignInError | null;
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const id = `auth-v2-${name}`;
  const invalid = error !== null;
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        {label}
      </label>
      <AuthV2PasswordInput
        ariaDescribedBy={invalid ? AUTH_V2_SIGN_IN_ERROR_ID : undefined}
        ariaInvalid={invalid ? true : undefined}
        autoComplete={autoComplete}
        hidePasswordLabel={copy.hidePassword}
        id={id}
        name={name}
        onChange={onChange}
        required
        showPasswordLabel={copy.showPassword}
        value={value}
      />
      {error ? (
        <AuthV2FieldError
          focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
          id={AUTH_V2_SIGN_IN_ERROR_ID}
          message={signInErrorMessage(error, copy)}
        />
      ) : null}
    </div>
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
    <Button className="w-full text-[13px]" disabled={disabled} type="submit">
      {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}

function IdentifierStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const identifier = useGet(signals.identifier$);
  const error = useGet(signals.error$);
  const pageSignal = useGet(pageSignal$);
  const setIdentifier = useSet(signals.setIdentifier$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const oauthFactors = state.factors.filter((factor) => {
    return factor.kind === "oauth";
  });
  const passkeyFactor = state.factors.find((factor) => {
    return factor.kind === "passkey";
  });
  const operationPending =
    submitLoadable.state === "loading" || selectLoadable.state === "loading";
  const identifierLabel =
    state.identifierMode === "email"
      ? copy.emailAddressLabel
      : state.identifierMode === "username"
        ? copy.usernameLabel
        : copy.identifierLabel;
  const identifierPlaceholder =
    state.identifierMode === "email"
      ? copy.emailAddressPlaceholder
      : state.identifierMode === "username"
        ? copy.usernamePlaceholder
        : copy.identifierPlaceholder;
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  const handleSelectFactor = (factorId: string): void => {
    detach(
      selectFactor(factorId, pageSignal),
      Reason.DomCallback,
      "select auth v2 sign in factor",
    );
  };
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert
        copy={copy}
        handledFields={["identifier"]}
        signals={signals}
      />
      {oauthFactors.length > 0 ? (
        <div
          className={cn(
            "grid gap-2",
            oauthFactors.length > 1 && "sm:grid-cols-2",
          )}
        >
          {oauthFactors.map((factor) => {
            return (
              <Button
                aria-label={signInFactorLabel(factor, copy)}
                className="w-full text-[13px]"
                disabled={operationPending}
                key={factor.id}
                type="button"
                variant="outline"
                onClick={() => {
                  handleSelectFactor(factor.id);
                }}
              >
                <AuthV2OAuthIcon strategy={factor.strategy} />
                {factor.strategy === "oauth_apple"
                  ? copy.appleProvider
                  : copy.googleProvider}
              </Button>
            );
          })}
        </div>
      ) : null}
      {oauthFactors.length > 0 ? (
        <AuthV2Divider label={copy.separator} />
      ) : null}
      <TextField
        autoComplete={state.identifierMode === "email" ? "email" : "username"}
        copy={copy}
        error={error?.field === "identifier" ? error : null}
        inputMode={state.identifierMode === "email" ? "email" : undefined}
        label={identifierLabel}
        name="identifier"
        onChange={setIdentifier}
        placeholder={identifierPlaceholder}
        value={identifier}
      />
      <SubmitButton
        busy={submitLoadable.state === "loading"}
        disabled={operationPending}
        label={copy.continue}
      />
      {passkeyFactor ? (
        <>
          <AuthV2Divider label={copy.separator} />
          <Button
            className="w-full text-[13px]"
            disabled={operationPending}
            type="button"
            variant="outline"
            onClick={() => {
              handleSelectFactor(passkeyFactor.id);
            }}
          >
            {signInFactorLabel(passkeyFactor, copy)}
          </Button>
        </>
      ) : null}
    </form>
  );
}

function ChooseSessionStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const pageSignal = useGet(pageSignal$);
  const useAnotherAccount = useSet(signals.useAnotherAccount$);
  const [selectionLoadable, selectSession] = useLoadableSet(
    signals.selectSession$,
  );
  const selectAccount = (sessionId: string): void => {
    detach(
      selectSession(sessionId, pageSignal),
      Reason.DomCallback,
      "select existing auth v2 session",
    );
  };
  return (
    <div className="space-y-4">
      <FlowErrorAlert copy={copy} signals={signals} />
      <div className="space-y-2">
        {state.accounts.map((account) => {
          return (
            <Button
              className="h-auto w-full justify-start py-3"
              disabled={selectionLoadable.state === "loading"}
              key={account.sessionId}
              type="button"
              variant="outline"
              onClick={() => {
                selectAccount(account.sessionId);
              }}
            >
              <span className="min-w-0 text-left">
                <span className="block truncate">{account.displayName}</span>
                {account.identifier &&
                account.identifier !== account.displayName ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {account.identifier}
                  </span>
                ) : null}
              </span>
            </Button>
          );
        })}
      </div>
      <Button
        className="w-full"
        disabled={selectionLoadable.state === "loading"}
        type="button"
        variant="ghost"
        onClick={useAnotherAccount}
      >
        {copy.addAccount}
      </Button>
    </div>
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
              {factor.kind === "oauth" ? (
                <AuthV2OAuthIcon strategy={factor.strategy} />
              ) : null}
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
  const error = useGet(signals.error$);
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
      <FlowErrorAlert
        copy={copy}
        handledFields={["password"]}
        signals={signals}
      />
      <PasswordField
        autoComplete="current-password"
        copy={copy}
        error={error?.field === "password" ? error : null}
        label={copy.passwordLabel}
        name="password"
        onChange={setPassword}
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
  signals,
  state,
}: SignInStepProps & {
  readonly state: IncompleteSignInState;
}) {
  const code = useGet(signals.code$);
  const error = useGet(signals.error$);
  const resendState = useGet(signals.resendState$);
  const pageSignal = useGet(pageSignal$);
  const setCode = useSet(signals.setCode$);
  const backToIdentifier = useSet(signals.backToIdentifier$);
  const backToMethods = useSet(signals.backToMethods$);
  const resendCooldownLifecycleRef = useSet(
    signals.resendCooldownLifecycleRef$,
  );
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [resendLoadable, resendCode] = useLoadableSet(signals.resendCode$);
  const submitting = submitLoadable.state === "loading";
  const resending = resendLoadable.state === "loading";
  const expired = error?.code === "code-expired";
  const coolingDown = resendState.status === "cooling-down";
  const operationPending = submitting || resending;
  const selectedFactor = state.selectedFactor;
  const clientTrust = selectedFactor?.kind === "client-trust-email-code";
  const safeIdentifier =
    selectedFactor &&
    (selectedFactor.kind === "email-code" ||
      selectedFactor.kind === "password-reset" ||
      selectedFactor.kind === "client-trust-email-code")
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
      {coolingDown ? <span ref={resendCooldownLifecycleRef} hidden /> : null}
      <FlowErrorAlert copy={copy} handledFields={["code"]} signals={signals} />
      {safeIdentifier ? (
        <p className="text-sm text-muted-foreground">{safeIdentifier}</p>
      ) : null}
      <AuthV2OtpInput
        errorId={AUTH_V2_SIGN_IN_ERROR_ID}
        invalid={error?.field === "code"}
        label={copy.codeLabel}
        name="code"
        onChange={setCode}
        value={code}
      />
      {error?.field === "code" ? (
        <AuthV2FieldError
          focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
          id={AUTH_V2_SIGN_IN_ERROR_ID}
          message={signInErrorMessage(error, copy)}
        />
      ) : null}
      <Button
        className="h-auto w-full"
        disabled={operationPending || (coolingDown && !expired)}
        type="button"
        variant={expired ? "outline" : "link"}
        onClick={handleResend}
      >
        {resending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : null}
        {coolingDown && !expired
          ? copy.resendCodeCooldown(resendState.remainingSeconds)
          : copy.resendCode}
      </Button>
      <SubmitButton
        busy={submitting}
        disabled={operationPending || expired}
        label={copy.continue}
      />
      <Button
        className="w-full"
        type="button"
        variant="ghost"
        onClick={clientTrust ? backToIdentifier : backToMethods}
      >
        {copy.back}
      </Button>
    </form>
  );
}

function NewPasswordStep({ copy, signals }: SignInStepProps) {
  const newPassword = useGet(signals.newPassword$);
  const confirmPassword = useGet(signals.confirmPassword$);
  const error = useGet(signals.error$);
  const pageSignal = useGet(pageSignal$);
  const setNewPassword = useSet(signals.setNewPassword$);
  const setConfirmPassword = useSet(signals.setConfirmPassword$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const newPasswordError =
    error?.field === "new-password" && error.code !== "password-mismatch"
      ? error
      : null;
  const confirmationError =
    error?.field === "new-password" && error.code === "password-mismatch"
      ? error
      : null;
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert
        copy={copy}
        handledFields={["new-password"]}
        signals={signals}
      />
      <PasswordField
        autoComplete="new-password"
        copy={copy}
        error={newPasswordError}
        label={copy.newPasswordLabel}
        name="new-password"
        onChange={setNewPassword}
        value={newPassword}
      />
      <PasswordField
        autoComplete="new-password"
        copy={copy}
        error={confirmationError}
        label={copy.confirmPasswordLabel}
        name="confirm-password"
        onChange={setConfirmPassword}
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

function CompleteStep() {
  return (
    <div
      className="flex flex-col items-center gap-3 py-8 text-center"
      role="status"
    >
      <Loader2
        className="animate-spin text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}

function TransferStep({
  copy,
  signUpHref,
  signals,
}: SignInStepProps & { readonly signUpHref: string }) {
  const restart = useSet(signals.restart$);
  return (
    <div className="space-y-3">
      <Button className="w-full" asChild>
        <SignUpLink signUpHref={signUpHref}>{copy.signUp}</SignUpLink>
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
  signUpHref,
  signals,
  state,
}: SignInStepProps & {
  readonly signUpHref: string;
  readonly state: AuthV2SignInState;
}) {
  if (state.status === "loading") {
    return <LoadingStep copy={copy} />;
  }
  if (state.status === "complete") {
    return <CompleteStep />;
  }
  if (state.status === "transfer") {
    return (
      <TransferStep copy={copy} signUpHref={signUpHref} signals={signals} />
    );
  }
  if (state.status === "unknown") {
    return <UnknownStep copy={copy} signals={signals} />;
  }
  if (state.step === "choose-session") {
    return <ChooseSessionStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "identifier") {
    return <IdentifierStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "choose-factor") {
    return <ChooseFactorStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "password") {
    return <PasswordStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "email-code") {
    return <CodeStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "client-trust-code") {
    return (
      <CodeStep copy={copy} reset={false} signals={signals} state={state} />
    );
  }
  if (state.step === "password-reset-code") {
    return <CodeStep copy={copy} signals={signals} state={state} />;
  }
  return <NewPasswordStep copy={copy} signals={signals} />;
}

export function SignInSwitch({
  copy,
  signUpHref,
}: {
  readonly copy: AuthV2SignInCopy;
  readonly signUpHref: string;
}) {
  return (
    <p className="text-center text-sm text-muted-foreground">
      {copy.noAccount}{" "}
      <SignUpLink
        className="font-medium text-foreground underline underline-offset-4"
        signUpHref={signUpHref}
      >
        {copy.signUp}
      </SignUpLink>
    </p>
  );
}
