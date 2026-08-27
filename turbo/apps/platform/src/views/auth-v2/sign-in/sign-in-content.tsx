import { Button, Checkbox, cn, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronRight, Loader2, Mail } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import type {
  AuthV2SignInError,
  AuthV2SignInErrorField,
  AuthV2SignInFactor,
  AuthV2SignInSignals,
  AuthV2SignInState,
} from "../../../signals/auth-v2/sign-in-flow.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { Link } from "../../router/link.tsx";
import {
  AUTH_V2_LINK_ACTION_CLASS,
  AUTH_V2_PRIMARY_ACTION_CLASS,
} from "../auth-v2-action-styles.ts";
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
type SignInFactorKind = NonNullable<
  IncompleteSignInState["selectedFactor"]
>["kind"];

interface SignInStepProps {
  readonly copy: AuthV2SignInCopy;
  readonly signals: AuthV2SignInSignals;
}

const AUTH_V2_SIGN_IN_ERROR_ID = "auth-v2-sign-in-error";

function FactorActionContent({
  busy,
  children,
}: {
  readonly busy: boolean;
  readonly children: ReactNode;
}) {
  return busy ? (
    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
  ) : (
    children
  );
}

function OAuthFactorButton({
  busy,
  copy,
  disabled,
  factor,
  onSelect,
}: {
  readonly busy: boolean;
  readonly copy: AuthV2SignInCopy;
  readonly disabled: boolean;
  readonly factor: Extract<AuthV2SignInFactor, { kind: "oauth" }>;
  readonly onSelect: (factorId: string) => void;
}) {
  const actionLabel = signInFactorLabel(factor, copy);
  return (
    <Button
      aria-busy={busy}
      aria-label={actionLabel}
      className="relative w-full border border-border bg-transparent text-sm hover:bg-muted"
      disabled={disabled}
      type="button"
      variant="outline"
      onClick={() => {
        onSelect(factor.id);
      }}
    >
      <FactorActionContent busy={busy}>
        <AuthV2OAuthIcon strategy={factor.strategy} />
        {factor.strategy === "oauth_apple"
          ? copy.appleProvider
          : copy.googleProvider}
      </FactorActionContent>
      {factor.lastUsed ? (
        <span className="pointer-events-none absolute right-2 top-0 z-10 -translate-y-1/2 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground shadow-sm">
          {copy.lastUsed}
        </span>
      ) : null}
    </Button>
  );
}

function selectRecoveryFactor(
  selectFactor: (factorId: string, signal: AbortSignal) => Promise<void>,
  factorId: string,
  pageSignal: AbortSignal,
): void {
  detach(
    selectFactor(factorId, pageSignal),
    Reason.DomCallback,
    "select auth v2 password recovery factor",
  );
}

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

function identifierFieldPresentation(
  mode: IncompleteSignInState["identifierMode"],
  copy: AuthV2SignInCopy,
) {
  if (mode === "email") {
    return {
      autoComplete: "email",
      inputMode: "email" as const,
      label: copy.emailAddressLabel,
      placeholder: copy.emailAddressPlaceholder,
    };
  }
  if (mode === "username") {
    return {
      autoComplete: "username",
      inputMode: undefined,
      label: copy.usernameLabel,
      placeholder: copy.usernamePlaceholder,
    };
  }
  return {
    autoComplete: "username",
    inputMode: undefined,
    label: copy.identifierLabel,
    placeholder: copy.identifierPlaceholder,
  };
}

function IdentifierStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const identifier = useGet(signals.identifier$);
  const error = useGet(signals.error$);
  const pendingFactorId = useGet(signals.pendingFactorId$);
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
  const selectingFactorId =
    selectLoadable.state === "loading" ? pendingFactorId : null;
  const field = identifierFieldPresentation(state.identifierMode, copy);
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
            const busy = selectingFactorId === factor.id;
            return (
              <OAuthFactorButton
                busy={busy}
                copy={copy}
                disabled={operationPending}
                factor={factor}
                key={factor.id}
                onSelect={handleSelectFactor}
              />
            );
          })}
        </div>
      ) : null}
      {oauthFactors.length > 0 ? (
        <AuthV2Divider label={copy.separator} />
      ) : null}
      <div className="flex flex-col gap-8">
        <TextField
          autoComplete={field.autoComplete}
          copy={copy}
          error={error?.field === "identifier" ? error : null}
          inputMode={field.inputMode}
          label={field.label}
          name="identifier"
          onChange={setIdentifier}
          placeholder={field.placeholder}
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
            aria-busy={selectingFactorId === passkeyFactor.id}
            aria-label={signInFactorLabel(passkeyFactor, copy)}
            className="w-full text-[13px]"
            disabled={operationPending}
            type="button"
            variant="outline"
            onClick={() => {
              handleSelectFactor(passkeyFactor.id);
            }}
          >
            <FactorActionContent busy={selectingFactorId === passkeyFactor.id}>
              {signInFactorLabel(passkeyFactor, copy)}
            </FactorActionContent>
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
        className={cn("w-full", AUTH_V2_LINK_ACTION_CLASS)}
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
  const pendingFactorId = useGet(signals.pendingFactorId$);
  const back = useSet(signals.backFromMethods$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const selectingFactorId =
    selectLoadable.state === "loading" ? pendingFactorId : null;
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
              const busy = selectingFactorId === factor.id;
              return (
                <OAuthFactorButton
                  busy={busy}
                  copy={copy}
                  disabled={selectLoadable.state === "loading"}
                  factor={factor}
                  key={factor.id}
                  onSelect={handleSelectFactor}
                />
              );
            })}
          </div>
        ) : null}
        {credentialFactors.map((factor) => {
          const actionLabel = signInFactorLabel(factor, copy);
          const busy = selectingFactorId === factor.id;
          return (
            <Button
              aria-busy={busy}
              aria-label={actionLabel}
              className={cn(
                "w-full px-3 text-sm",
                busy ? "justify-center" : "justify-between",
              )}
              disabled={selectLoadable.state === "loading"}
              key={factor.id}
              type="button"
              variant="outline"
              onClick={() => {
                handleSelectFactor(factor.id);
              }}
            >
              <FactorActionContent busy={busy}>
                <span className="flex min-w-0 items-center gap-2">
                  {factor.kind === "email-code" ? (
                    <Mail className="size-4 shrink-0" aria-hidden="true" />
                  ) : null}
                  <span className="truncate">{actionLabel}</span>
                </span>
                <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
              </FactorActionContent>
            </Button>
          );
        })}
      </div>
      <Button
        className={cn(
          "mx-auto h-auto w-fit p-0 text-sm leading-5",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
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
                className={cn(
                  "h-auto p-0 text-[13px] leading-[17px]",
                  AUTH_V2_LINK_ACTION_CLASS,
                )}
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
        className={cn(
          "mx-auto h-auto w-fit p-0 text-sm leading-5",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
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

function passwordRecoveryFactors(state: IncompleteSignInState) {
  const resetFactor = state.factors.find((factor) => {
    return factor.kind === "password-reset";
  });
  const oauthFactors = state.factors.filter((factor) => {
    return factor.kind === "oauth";
  });
  const alternativeFactors = state.factors.filter((factor) => {
    return factor.kind === "email-code" || factor.kind === "passkey";
  });
  return {
    alternativeFactors,
    hasAlternativeMethods:
      oauthFactors.length > 0 || alternativeFactors.length > 0,
    oauthFactors,
    resetFactor,
  };
}

function PasswordRecoveryStep({
  copy,
  signals,
  state,
}: SignInStepProps & { readonly state: IncompleteSignInState }) {
  const pageSignal = useGet(pageSignal$);
  const pendingFactorId = useGet(signals.pendingFactorId$);
  const back = useSet(signals.backFromPasswordRecovery$);
  const [selectLoadable, selectFactor] = useLoadableSet(signals.selectFactor$);
  const factors = passwordRecoveryFactors(state);
  const resetFactor = factors.resetFactor;
  const selecting = selectLoadable.state === "loading";
  const selectingFactorId = selecting ? pendingFactorId : null;
  const handleSelectFactor = (factorId: string): void => {
    selectRecoveryFactor(selectFactor, factorId, pageSignal);
  };
  return (
    <div className="flex flex-col gap-6">
      <FlowErrorAlert copy={copy} signals={signals} />
      {resetFactor ? (
        <Button
          aria-busy={selectingFactorId === resetFactor.id}
          aria-label={copy.passwordResetMethod}
          className={cn("w-full text-[13px]", AUTH_V2_PRIMARY_ACTION_CLASS)}
          disabled={selecting}
          type="button"
          onClick={() => {
            handleSelectFactor(resetFactor.id);
          }}
        >
          <FactorActionContent busy={selectingFactorId === resetFactor.id}>
            {copy.passwordResetMethod}
          </FactorActionContent>
        </Button>
      ) : null}
      {factors.hasAlternativeMethods ? (
        <AuthV2Divider label={copy.recoveryMethodsDivider} />
      ) : null}
      <div className="flex flex-col gap-4">
        {factors.hasAlternativeMethods ? (
          <div className="flex flex-col gap-2">
            {factors.oauthFactors.length > 0 ? (
              <div
                className={cn(
                  "grid gap-2",
                  factors.oauthFactors.length > 1 && "sm:grid-cols-2",
                )}
              >
                {factors.oauthFactors.map((factor) => {
                  const busy = selectingFactorId === factor.id;
                  return (
                    <OAuthFactorButton
                      busy={busy}
                      copy={copy}
                      disabled={selecting}
                      factor={factor}
                      key={factor.id}
                      onSelect={handleSelectFactor}
                    />
                  );
                })}
              </div>
            ) : null}
            {factors.alternativeFactors.map((factor) => {
              const actionLabel = signInFactorLabel(factor, copy);
              const busy = selectingFactorId === factor.id;
              return (
                <Button
                  aria-busy={busy}
                  aria-label={actionLabel}
                  className={cn(
                    "w-full px-3 text-sm",
                    busy ? "justify-center" : "justify-between",
                  )}
                  disabled={selecting}
                  key={factor.id}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    handleSelectFactor(factor.id);
                  }}
                >
                  <FactorActionContent busy={busy}>
                    <span className="flex min-w-0 items-center gap-2">
                      {factor.kind === "email-code" ? (
                        <Mail className="size-4 shrink-0" aria-hidden="true" />
                      ) : null}
                      <span className="truncate">{actionLabel}</span>
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
                  </FactorActionContent>
                </Button>
              );
            })}
          </div>
        ) : null}
        <Button
          className={cn(
            "mx-auto h-auto w-fit p-0 text-sm leading-5",
            AUTH_V2_LINK_ACTION_CLASS,
          )}
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
      <Button
        className={cn("w-full text-[13px]", AUTH_V2_PRIMARY_ACTION_CLASS)}
        asChild
      >
        <a href={copy.supportEmailHref}>
          {copy.emailSupport}
          <AuthV2ActionGlyph />
        </a>
      </Button>
      <Button
        className={cn(
          "mx-auto h-auto w-fit p-0 text-sm leading-5",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
        type="button"
        variant="link"
        onClick={back}
      >
        {copy.back}
      </Button>
    </div>
  );
}

function ClientTrustNotice({
  copy,
  visible,
}: {
  readonly copy: AuthV2SignInCopy;
  readonly visible: boolean;
}) {
  if (!visible) {
    return null;
  }
  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-xs leading-4 text-amber-700 dark:text-amber-300">
      {copy.clientTrustNotice}
    </p>
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
          {clientTrust ? (
            <p className="text-center text-sm text-muted-foreground">
              {selectedFactor.safeIdentifier}
            </p>
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
            className={cn(
              expired
                ? "w-full"
                : "mx-auto h-auto w-fit p-0 text-[13px] leading-[17px]",
              AUTH_V2_LINK_ACTION_CLASS,
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
          <ClientTrustNotice copy={copy} visible={clientTrust} />
        </div>
        <AuthV2SubmitButton
          busy={submitting}
          disabled={operationPending || expired}
          label={copy.continue}
        />
      </form>
      <CodeStepBottomAction
        backToIdentifier={backToIdentifier}
        backToMethods={backToMethods}
        copy={copy}
        disabled={operationPending}
        factorKind={selectedFactor?.kind ?? null}
      />
    </div>
  );
}

function CodeStepBottomAction({
  backToIdentifier,
  backToMethods,
  copy,
  disabled,
  factorKind,
}: {
  readonly backToIdentifier: () => void;
  readonly backToMethods: () => void;
  readonly copy: AuthV2SignInCopy;
  readonly disabled: boolean;
  readonly factorKind: SignInFactorKind | null;
}) {
  if (factorKind === "email-code") {
    return (
      <Button
        className={cn(
          "mx-auto h-auto w-fit p-0 text-sm leading-5",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
        disabled={disabled}
        type="button"
        variant="link"
        onClick={backToMethods}
      >
        {copy.useAnotherMethod}
      </Button>
    );
  }
  if (factorKind !== "client-trust-email-code") {
    return null;
  }
  return (
    <Button
      className={cn(
        "mx-auto h-auto w-fit p-0 text-sm leading-5",
        AUTH_V2_LINK_ACTION_CLASS,
      )}
      disabled={disabled}
      type="button"
      variant="link"
      onClick={backToIdentifier}
    >
      {copy.back}
    </Button>
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
              className="mt-0.5"
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
        className={cn(
          "mx-auto h-auto w-fit p-0 text-sm leading-5",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
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
      <Button className={cn("w-full", AUTH_V2_PRIMARY_ACTION_CLASS)} asChild>
        <SignUpLink signUpHref={signUpHref}>{copy.signUp}</SignUpLink>
      </Button>
      <Button
        className={cn("w-full", AUTH_V2_LINK_ACTION_CLASS)}
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
    return <CodeStep copy={copy} signals={signals} state={state} />;
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
        className={cn(
          "font-medium underline underline-offset-4",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
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
        className={cn(
          "h-auto p-0 font-medium underline underline-offset-4",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
        type="button"
        variant="link"
        onClick={showHelp}
      >
        {copy.getHelp}
      </Button>
    </p>
  );
}
