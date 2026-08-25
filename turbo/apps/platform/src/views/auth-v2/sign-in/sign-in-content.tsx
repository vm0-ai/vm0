import { Button, Checkbox, cn, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronRight, Loader2, Mail } from "lucide-react";
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
  AuthV2ActionGlyph,
  AuthV2SubmitButton,
} from "../auth-v2-submit-button.tsx";
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
      <label className="block text-sm font-medium text-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        aria-describedby={invalid ? AUTH_V2_SIGN_IN_ERROR_ID : undefined}
        aria-invalid={invalid ? true : undefined}
        className="border border-border"
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
  labelAction,
  name,
  onChange,
  placeholder,
  value,
}: {
  readonly autoComplete: string;
  readonly copy: AuthV2SignInCopy;
  readonly error: AuthV2SignInError | null;
  readonly label: string;
  readonly labelAction?: ReactNode;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}) {
  const id = `auth-v2-${name}`;
  const invalid = error !== null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <label
          className="block text-sm font-medium text-foreground"
          htmlFor={id}
        >
          {label}
        </label>
        {labelAction}
      </div>
      <AuthV2PasswordInput
        ariaDescribedBy={invalid ? AUTH_V2_SIGN_IN_ERROR_ID : undefined}
        ariaInvalid={invalid ? true : undefined}
        autoComplete={autoComplete}
        hidePasswordLabel={copy.hidePassword}
        id={id}
        name={name}
        onChange={onChange}
        placeholder={placeholder}
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
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
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
                className="w-full border border-border bg-transparent text-sm hover:bg-muted"
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
      <div className="flex flex-col gap-8">
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
        <AuthV2SubmitButton
          busy={submitLoadable.state === "loading"}
          disabled={operationPending}
          label={copy.continue}
        />
      </div>
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
  const back = useSet(signals.backFromMethods$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const availableFactors = state.factors.filter((factor) => {
    return (
      factor.kind !== "password-reset" && factor.id !== state.selectedFactor?.id
    );
  });
  const oauthFactors = availableFactors.filter((factor) => {
    return factor.kind === "oauth";
  });
  const credentialFactors = availableFactors.filter((factor) => {
    return factor.kind !== "oauth";
  });
  const handleSelectFactor = (factorId: string): void => {
    detach(
      selectFactor(factorId, pageSignal),
      Reason.DomCallback,
      "select auth v2 sign in factor",
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <FlowErrorAlert copy={copy} signals={signals} />
      <div className="flex flex-col gap-2">
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
                  className="w-full border border-border bg-transparent text-sm hover:bg-muted"
                  disabled={selectLoadable.state === "loading"}
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
        {credentialFactors.map((factor) => {
          return (
            <Button
              className="h-auto w-full justify-between px-0 py-1.5 text-sm"
              disabled={selectLoadable.state === "loading"}
              key={factor.id}
              type="button"
              variant="ghost"
              onClick={() => {
                handleSelectFactor(factor.id);
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                {factor.kind === "email-code" ? (
                  <Mail className="size-4 shrink-0" aria-hidden="true" />
                ) : null}
                <span className="truncate">
                  {signInFactorLabel(factor, copy)}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
            </Button>
          );
        })}
      </div>
      <Button
        className="mx-auto h-auto w-fit p-0 text-sm leading-5"
        disabled={selectLoadable.state === "loading"}
        type="button"
        variant="link"
        onClick={back}
      >
        {copy.back}
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
  const showPasswordRecovery = useSet(signals.showPasswordRecovery$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const resetFactor = state.factors.find((factor) => {
    return factor.kind === "password-reset";
  });
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign in");
  };
  const submitting = submitLoadable.state === "loading";
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-8" onSubmit={handleSubmit}>
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
          labelAction={
            resetFactor ? (
              <Button
                className="h-auto p-0 text-[13px] leading-[17px]"
                disabled={submitting}
                type="button"
                variant="link"
                onClick={showPasswordRecovery}
              >
                {copy.forgotPassword}
              </Button>
            ) : null
          }
          name="password"
          onChange={setPassword}
          placeholder={copy.passwordPlaceholder}
          value={password}
        />
        <AuthV2SubmitButton busy={submitting} label={copy.continue} />
      </form>
      <Button
        className="mx-auto h-auto w-fit p-0 text-sm leading-5"
        disabled={submitting}
        type="button"
        variant="link"
        onClick={backToMethods}
      >
        {copy.useAnotherMethod}
      </Button>
    </div>
  );
}

function PasswordRecoveryStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const pageSignal = useGet(pageSignal$);
  const back = useSet(signals.backFromPasswordRecovery$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const resetFactor = state.factors.find((factor) => {
    return factor.kind === "password-reset";
  });
  const oauthFactors = state.factors.filter((factor) => {
    return factor.kind === "oauth";
  });
  const alternativeFactors = state.factors.filter((factor) => {
    return factor.kind === "email-code" || factor.kind === "passkey";
  });
  const selecting = selectLoadable.state === "loading";
  const handleSelectFactor = (factorId: string): void => {
    detach(
      selectFactor(factorId, pageSignal),
      Reason.DomCallback,
      "select auth v2 password recovery factor",
    );
  };
  const hasAlternativeMethods =
    oauthFactors.length > 0 || alternativeFactors.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <FlowErrorAlert copy={copy} signals={signals} />
      {resetFactor ? (
        <Button
          className="w-full text-[13px]"
          disabled={selecting}
          type="button"
          onClick={() => {
            handleSelectFactor(resetFactor.id);
          }}
        >
          {copy.passwordResetMethod}
          {selecting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
        </Button>
      ) : null}
      {hasAlternativeMethods ? (
        <AuthV2Divider label={copy.recoveryMethodsDivider} />
      ) : null}
      <div className="flex flex-col gap-4">
        {hasAlternativeMethods ? (
          <div className="flex flex-col gap-2">
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
                      className="w-full border border-border bg-transparent text-sm hover:bg-muted"
                      disabled={selecting}
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
            {alternativeFactors.map((factor) => {
              return (
                <Button
                  className="h-auto w-full justify-between px-0 py-1.5 text-sm"
                  disabled={selecting}
                  key={factor.id}
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    handleSelectFactor(factor.id);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {factor.kind === "email-code" ? (
                      <Mail className="size-4 shrink-0" aria-hidden="true" />
                    ) : null}
                    <span className="truncate">
                      {signInFactorLabel(factor, copy)}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                </Button>
              );
            })}
          </div>
        ) : null}
        <Button
          className="mx-auto h-auto w-fit p-0 text-sm leading-5"
          disabled={selecting}
          type="button"
          variant="link"
          onClick={back}
        >
          {copy.back}
        </Button>
      </div>
    </div>
  );
}

function HelpStep({ copy, signals }: SignInStepProps) {
  const back = useSet(signals.backFromHelp$);
  return (
    <div className="flex flex-col gap-4">
      <Button className="w-full text-[13px]" asChild>
        <a href={copy.supportEmailHref}>
          {copy.emailSupport}
          <AuthV2ActionGlyph />
        </a>
      </Button>
      <Button
        className="mx-auto h-auto w-fit p-0 text-sm leading-5"
        type="button"
        variant="link"
        onClick={back}
      >
        {copy.back}
      </Button>
    </div>
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
  const showsMethodChooser = state.selectedFactor?.kind === "email-code";
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
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-8" onSubmit={handleSubmit}>
        {coolingDown ? <span ref={resendCooldownLifecycleRef} hidden /> : null}
        <div className="flex flex-col gap-2">
          <FlowErrorAlert
            copy={copy}
            handledFields={["code"]}
            signals={signals}
          />
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
            className={cn(
              expired
                ? "w-full"
                : "mx-auto h-auto w-fit p-0 text-[13px] leading-[17px]",
            )}
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
        </div>
        <AuthV2SubmitButton
          busy={submitting}
          disabled={operationPending || expired}
          label={copy.continue}
        />
      </form>
      {showsMethodChooser ? (
        <Button
          className="mx-auto h-auto w-fit p-0 text-sm leading-5"
          disabled={operationPending}
          type="button"
          variant="link"
          onClick={backToMethods}
        >
          {copy.useAnotherMethod}
        </Button>
      ) : null}
      {clientTrust ? (
        <Button
          className="mx-auto h-auto w-fit p-0 text-sm leading-5"
          disabled={operationPending}
          type="button"
          variant="link"
          onClick={backToIdentifier}
        >
          {copy.back}
        </Button>
      ) : null}
    </div>
  );
}

function NewPasswordStep({ copy, signals }: SignInStepProps) {
  const newPassword = useGet(signals.newPassword$);
  const confirmPassword = useGet(signals.confirmPassword$);
  const signOutOfOtherSessions = useGet(signals.signOutOfOtherSessions$);
  const error = useGet(signals.error$);
  const pageSignal = useGet(pageSignal$);
  const setNewPassword = useSet(signals.setNewPassword$);
  const setConfirmPassword = useSet(signals.setConfirmPassword$);
  const setSignOutOfOtherSessions = useSet(signals.setSignOutOfOtherSessions$);
  const back = useSet(signals.backFromNewPassword$);
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
  const submitting = submitLoadable.state === "loading";
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-8" onSubmit={handleSubmit}>
        <FlowErrorAlert
          copy={copy}
          handledFields={["new-password"]}
          signals={signals}
        />
        <div className="flex flex-col gap-6">
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
        </div>
        <div className="flex flex-col gap-6">
          <label className="flex cursor-pointer items-start gap-1.5 text-sm leading-5 font-medium text-foreground">
            <Checkbox
              checked={signOutOfOtherSessions}
              className="mt-0.5 size-4 shrink-0 rounded-[3px] border-foreground/35"
              onCheckedChange={(checked) => {
                setSignOutOfOtherSessions(checked === true);
              }}
            />
            <span>{copy.signOutOfOtherSessions}</span>
          </label>
          <AuthV2SubmitButton
            busy={submitting}
            label={copy.resetPassword}
            showIdleGlyph={false}
          />
        </div>
      </form>
      <Button
        className="mx-auto h-auto w-fit p-0 text-sm leading-5"
        disabled={submitting}
        type="button"
        variant="link"
        onClick={back}
      >
        {copy.back}
      </Button>
    </div>
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
  if (state.step === "password-recovery") {
    return <PasswordRecoveryStep copy={copy} signals={signals} state={state} />;
  }
  if (state.step === "help") {
    return <HelpStep copy={copy} signals={signals} />;
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

export function SignInMethodsHelpFooter({ copy, signals }: SignInStepProps) {
  const showHelp = useSet(signals.showHelp$);
  return (
    <p className="text-center text-sm text-muted-foreground">
      {copy.methodsHelpPrompt}{" "}
      <Button
        className="h-auto p-0 font-medium text-foreground underline underline-offset-4"
        type="button"
        variant="link"
        onClick={showHelp}
      >
        {copy.getHelp}
      </Button>
    </p>
  );
}
