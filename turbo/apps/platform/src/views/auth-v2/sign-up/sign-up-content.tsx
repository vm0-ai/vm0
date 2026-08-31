import { Button, Checkbox, cn, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import type {
  AuthV2SignUpError,
  AuthV2SignUpErrorField,
  AuthV2SignUpFields,
  AuthV2SignUpLegalConfig,
  AuthV2SignUpSignals,
  AuthV2SignUpState,
} from "../../../signals/auth-v2/sign-up-flow.ts";
import type { AuthV2OAuthStrategy } from "../../../signals/auth-v2/oauth-strategies.ts";
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
import { AuthV2SubmitButton } from "../auth-v2-submit-button.tsx";
import {
  type AuthV2SignUpCopy,
  resendCodeLabel,
  signUpErrorMessage,
} from "./sign-up-copy.ts";

type IncompleteSignUpState = Extract<
  AuthV2SignUpState,
  { status: "incomplete" }
>;

interface SignUpStepProps {
  readonly copy: AuthV2SignUpCopy;
  readonly signInHref: string;
  readonly signals: AuthV2SignUpSignals;
}

function TextField({
  autoComplete,
  copy,
  error,
  inputMode,
  hidePasswordLabel,
  label,
  name,
  onChange,
  optionalLabel,
  placeholder,
  required,
  showPasswordLabel,
  type = "text",
  value,
}: {
  readonly autoComplete: string;
  readonly copy: AuthV2SignUpCopy;
  readonly error: AuthV2SignUpError | null;
  readonly inputMode?: "email" | "numeric";
  readonly hidePasswordLabel?: string;
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly optionalLabel?: string;
  readonly placeholder: string;
  readonly required: boolean;
  readonly showPasswordLabel?: string;
  readonly type?: "email" | "password" | "text";
  readonly value: string;
}) {
  const id = `auth-v2-sign-up-${name}`;
  const errorId = `${id}-error`;
  const invalid = error !== null;
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-foreground" htmlFor={id}>
        {label}
        {!required && optionalLabel ? (
          <span className="ml-1 font-normal text-muted-foreground">
            ({optionalLabel})
          </span>
        ) : null}
      </label>
      {type === "password" && hidePasswordLabel && showPasswordLabel ? (
        <AuthV2PasswordInput
          ariaDescribedBy={invalid ? errorId : undefined}
          ariaInvalid={invalid ? true : undefined}
          autoComplete={autoComplete}
          hidePasswordLabel={hidePasswordLabel}
          id={id}
          name={name}
          onChange={onChange}
          placeholder={placeholder}
          required={required}
          showPasswordLabel={showPasswordLabel}
          value={value}
        />
      ) : (
        <Input
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid ? true : undefined}
          autoComplete={autoComplete}
          className="border border-border"
          id={id}
          inputMode={inputMode}
          name={name}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
          placeholder={placeholder}
          required={required}
          type={type}
          value={value}
        />
      )}
      {error ? (
        <AuthV2FieldError
          focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
          id={errorId}
          message={signUpErrorMessage(error, copy)}
        />
      ) : null}
    </div>
  );
}

function FlowErrorAlert({
  copy,
  handledFields = [],
  signals,
}: SignUpStepProps & {
  readonly handledFields?: readonly AuthV2SignUpErrorField[];
}) {
  const error = useGet(signals.error$);
  if (!error || handledFields.includes(error.field)) {
    return null;
  }
  return (
    <AuthV2ErrorAlert
      focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
      message={signUpErrorMessage(error, copy)}
    />
  );
}

function signInLinkOptions(signInHref: string) {
  const url = new URL(signInHref, location.origin);
  return {
    hash: url.hash,
    searchParams: url.searchParams,
  };
}

function SignInLink({
  children,
  className,
  signInHref,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly signInHref: string;
}) {
  return (
    <Link
      className={className}
      options={signInLinkOptions(signInHref)}
      pathname={ROUTES.signIn}
    >
      {children}
    </Link>
  );
}

function legalTemplate(
  legal: AuthV2SignUpLegalConfig,
  copy: AuthV2SignUpCopy,
): string {
  if (legal.termsUrl && legal.privacyPolicyUrl) {
    return copy.legalTermsAndPrivacy;
  }
  return legal.termsUrl ? copy.legalTermsOnly : copy.legalPrivacyOnly;
}

function LegalConsentText({
  copy,
  legal,
}: {
  readonly copy: AuthV2SignUpCopy;
  readonly legal: AuthV2SignUpLegalConfig;
}) {
  const template = legalTemplate(legal, copy);
  const tokenPattern = /<(terms|privacy)>(.*?)<\/\1>/g;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of template.matchAll(tokenPattern)) {
    const index = match.index;
    const token = match[1];
    const label = match[2];
    if (index === undefined || !token || !label) {
      continue;
    }
    if (index > cursor) {
      content.push(template.slice(cursor, index));
    }
    const href = token === "terms" ? legal.termsUrl : legal.privacyPolicyUrl;
    if (href) {
      content.push(
        <a
          className={cn(
            "font-medium underline underline-offset-4",
            AUTH_V2_LINK_ACTION_CLASS,
          )}
          href={href}
          key={`${token}-${index}`}
          rel="noreferrer"
          target="_blank"
        >
          {label}
        </a>,
      );
    } else {
      content.push(label);
    }
    cursor = index + match[0].length;
  }
  if (cursor < template.length) {
    content.push(template.slice(cursor));
  }
  return content;
}

function FieldList({
  copy,
  fields,
  signals,
}: {
  readonly copy: AuthV2SignUpCopy;
  readonly fields: AuthV2SignUpFields;
  readonly signals: AuthV2SignUpSignals;
}) {
  const emailAddress = useGet(signals.emailAddress$);
  const password = useGet(signals.password$);
  const firstName = useGet(signals.firstName$);
  const lastName = useGet(signals.lastName$);
  const error = useGet(signals.error$);
  const setEmailAddress = useSet(signals.setEmailAddress$);
  const setPassword = useSet(signals.setPassword$);
  const setFirstName = useSet(signals.setFirstName$);
  const setLastName = useSet(signals.setLastName$);
  const hasVisibleField = Object.values(fields).some((field) => {
    return field !== "hidden";
  });
  if (!hasVisibleField) {
    return null;
  }
  return (
    <div className="flex flex-col gap-6">
      {fields.emailAddress !== "hidden" ? (
        <TextField
          autoComplete="email"
          copy={copy}
          error={error?.field === "email-address" ? error : null}
          inputMode="email"
          label={copy.emailAddressLabel}
          name="email-address"
          onChange={setEmailAddress}
          optionalLabel={copy.optional}
          placeholder={copy.emailAddressPlaceholder}
          required={fields.emailAddress === "required"}
          type="email"
          value={emailAddress}
        />
      ) : null}
      {fields.password !== "hidden" ? (
        <TextField
          autoComplete="new-password"
          copy={copy}
          error={error?.field === "password" ? error : null}
          hidePasswordLabel={copy.hidePassword}
          label={copy.passwordLabel}
          name="password"
          onChange={setPassword}
          optionalLabel={copy.optional}
          placeholder={copy.passwordPlaceholder}
          required={fields.password === "required"}
          showPasswordLabel={copy.showPassword}
          type="password"
          value={password}
        />
      ) : null}
      {fields.firstName !== "hidden" ? (
        <TextField
          autoComplete="given-name"
          copy={copy}
          error={error?.field === "first-name" ? error : null}
          label={copy.firstNameLabel}
          name="first-name"
          onChange={setFirstName}
          optionalLabel={copy.optional}
          placeholder={copy.firstNamePlaceholder}
          required={fields.firstName === "required"}
          value={firstName}
        />
      ) : null}
      {fields.lastName !== "hidden" ? (
        <TextField
          autoComplete="family-name"
          copy={copy}
          error={error?.field === "last-name" ? error : null}
          label={copy.lastNameLabel}
          name="last-name"
          onChange={setLastName}
          optionalLabel={copy.optional}
          placeholder={copy.lastNamePlaceholder}
          required={fields.lastName === "required"}
          value={lastName}
        />
      ) : null}
    </div>
  );
}

function CaptchaStatus({ copy, signals }: SignUpStepProps) {
  const captchaState = useGet(signals.captchaState$);
  const error = useGet(signals.error$);
  if (captchaState === "idle") {
    return null;
  }
  if (captchaState === "error" || captchaState === "expired") {
    return (
      <AuthV2ErrorAlert
        focusKey={`captcha:${captchaState}:${error?.clerkCode ?? ""}`}
        message={
          captchaState === "expired" ? copy.captchaExpired : copy.captchaError
        }
      />
    );
  }
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2 className="mt-0.5 size-4 animate-spin" aria-hidden="true" />
      <span>
        <span className="block font-medium text-foreground">
          {captchaState === "blocked" ? copy.captchaTitle : copy.captchaLoading}
        </span>
        {captchaState === "blocked" ? (
          <span className="block">{copy.captchaSubtitle}</span>
        ) : null}
      </span>
    </div>
  );
}

function OAuthProviderActions({
  copy,
  disabled,
  onSelect,
  pendingStrategy,
  strategies,
}: {
  readonly copy: AuthV2SignUpCopy;
  readonly disabled: boolean;
  readonly onSelect: (strategy: AuthV2OAuthStrategy) => void;
  readonly pendingStrategy: AuthV2OAuthStrategy | null;
  readonly strategies: readonly AuthV2OAuthStrategy[];
}) {
  if (strategies.length === 0) {
    return null;
  }
  return (
    <>
      <div
        className={cn("grid gap-2", strategies.length > 1 && "sm:grid-cols-2")}
      >
        {strategies.map((strategy) => {
          const busy = pendingStrategy === strategy;
          const actionLabel =
            strategy === "oauth_apple" ? copy.appleMethod : copy.googleMethod;
          return (
            <Button
              aria-busy={busy}
              aria-label={actionLabel}
              className="w-full border border-border bg-transparent text-sm hover:bg-muted"
              disabled={disabled}
              key={strategy}
              type="button"
              variant="outline"
              onClick={() => {
                onSelect(strategy);
              }}
            >
              {busy ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <>
                  <AuthV2OAuthIcon strategy={strategy} />
                  {strategy === "oauth_apple"
                    ? copy.appleProvider
                    : copy.googleProvider}
                </>
              )}
            </Button>
          );
        })}
      </div>
      <AuthV2Divider label={copy.separator} />
    </>
  );
}

function DetailsStep({
  copy,
  signInHref,
  signals,
  state,
}: SignUpStepProps & {
  readonly state: Extract<IncompleteSignUpState, { step: "details" }>;
}) {
  const pageSignal = useGet(pageSignal$);
  const legalAccepted = useGet(signals.legalAccepted$);
  const oauthStrategies = useGet(signals.oauthStrategies$);
  const pendingOAuthStrategy = useGet(signals.pendingOAuthStrategy$);
  const captchaState = useGet(signals.captchaState$);
  const error = useGet(signals.error$);
  const setLegalAccepted = useSet(signals.setLegalAccepted$);
  const captchaRef = useSet(signals.captchaRef$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [oauthLoadable, startOAuth] = useLoadableSet(signals.startOAuth$);
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign up");
  };
  const handleOAuth = (strategy: AuthV2OAuthStrategy): void => {
    detach(
      startOAuth(strategy, pageSignal),
      Reason.DomCallback,
      "start auth v2 OAuth sign up",
    );
  };
  const retrying = captchaState === "error" || captchaState === "expired";
  const operationPending =
    submitLoadable.state === "loading" || oauthLoadable.state === "loading";
  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      <FlowErrorAlert
        copy={copy}
        handledFields={[
          "captcha",
          "email-address",
          "first-name",
          "last-name",
          "legal",
          "password",
        ]}
        signals={signals}
        signInHref={signInHref}
      />
      <OAuthProviderActions
        copy={copy}
        disabled={operationPending}
        onSelect={handleOAuth}
        pendingStrategy={pendingOAuthStrategy}
        strategies={oauthStrategies}
      />
      <div className="flex flex-col gap-8">
        <FieldList copy={copy} fields={state.fields} signals={signals} />
        <div className="flex flex-col gap-6">
          {state.legal.required ? (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-1.5 text-sm leading-5 font-medium text-foreground">
                <Checkbox
                  aria-describedby={
                    error?.field === "legal"
                      ? "auth-v2-sign-up-legal-error"
                      : undefined
                  }
                  aria-invalid={error?.field === "legal" ? true : undefined}
                  checked={legalAccepted}
                  className="mt-0.5"
                  onCheckedChange={(checked) => {
                    setLegalAccepted(checked === true);
                  }}
                />
                <span>
                  <LegalConsentText copy={copy} legal={state.legal} />
                </span>
              </label>
              {error?.field === "legal" ? (
                <AuthV2FieldError
                  focusKey={`${error.code}:${error.field}:${error.clerkCode ?? ""}`}
                  id="auth-v2-sign-up-legal-error"
                  message={signUpErrorMessage(error, copy)}
                />
              ) : null}
            </div>
          ) : null}
          {state.captchaEnabled ? (
            <div
              data-cl-size="flexible"
              data-cl-theme="auto"
              id="clerk-captcha"
              ref={captchaRef}
            />
          ) : null}
          <CaptchaStatus
            copy={copy}
            signals={signals}
            signInHref={signInHref}
          />
          <AuthV2SubmitButton
            busy={submitLoadable.state === "loading"}
            disabled={operationPending}
            label={retrying ? copy.retry : copy.continue}
          />
        </div>
      </div>
    </form>
  );
}

function emailCodeErrorMessage(
  copy: AuthV2SignUpCopy,
  error: AuthV2SignUpError | null,
  expired: boolean,
): string {
  if (expired) {
    return copy.codeExpired;
  }
  return error ? signUpErrorMessage(error, copy) : copy.unknownError;
}

function EmailCodeChallenge({
  code,
  copy,
  error,
  expired,
  onChange,
  prepareFailed,
  preparing,
}: {
  readonly code: string;
  readonly copy: AuthV2SignUpCopy;
  readonly error: AuthV2SignUpError | null;
  readonly expired: boolean;
  readonly onChange: (value: string) => void;
  readonly prepareFailed: boolean;
  readonly preparing: boolean;
}) {
  if (preparing) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="animate-spin" aria-hidden="true" />
        {copy.loading}
      </div>
    );
  }
  if (prepareFailed) {
    return null;
  }
  return (
    <>
      <AuthV2OtpInput
        errorId="auth-v2-sign-up-code-error"
        invalid={error !== null || expired}
        label={copy.codeLabel}
        name="code"
        onChange={onChange}
        value={code}
      />
      {error || expired ? (
        <AuthV2FieldError
          focusKey={
            expired
              ? "sign-up-code-expired"
              : `${error?.code}:${error?.field}:${error?.clerkCode ?? ""}`
          }
          id="auth-v2-sign-up-code-error"
          message={emailCodeErrorMessage(copy, error, expired)}
        />
      ) : null}
    </>
  );
}

function EmailCodeStep({
  copy,
  signInHref,
  signals,
  state,
}: SignUpStepProps & {
  readonly state: Extract<IncompleteSignUpState, { step: "email-code" }>;
}) {
  const code = useGet(signals.code$);
  const error = useGet(signals.error$);
  const resendState = useGet(signals.resendState$);
  const pageSignal = useGet(pageSignal$);
  const setCode = useSet(signals.setCode$);
  const resendCooldownLifecycleRef = useSet(
    signals.resendCooldownLifecycleRef$,
  );
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [resendLoadable, resendCode] = useLoadableSet(signals.resendCode$);
  const preparing = state.verification === "preparing";
  const prepareFailed = state.verification === "prepare-failed";
  const expired = state.verification === "expired";
  const codeError = error?.field === "code" ? error : null;
  const submitting = submitLoadable.state === "loading";
  const resending = resendLoadable.state === "loading";
  const coolingDown = resendState.status === "cooling-down";
  const operationPending = preparing || submitting || resending;
  const showsCodeInput = !preparing && !prepareFailed;
  const resendLabel = prepareFailed
    ? copy.retry
    : resendCodeLabel(resendState.remainingSeconds, copy);
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "verify auth v2 sign up");
  };
  const handleResend = (): void => {
    detach(
      resendCode(pageSignal),
      Reason.DomCallback,
      "resend auth v2 sign up code",
    );
  };
  return (
    <form className="flex flex-col gap-8" onSubmit={handleSubmit}>
      {coolingDown ? <span ref={resendCooldownLifecycleRef} hidden /> : null}
      <FlowErrorAlert
        copy={copy}
        handledFields={showsCodeInput ? ["code"] : []}
        signals={signals}
        signInHref={signInHref}
      />
      <div className="flex flex-col items-center gap-2">
        <EmailCodeChallenge
          code={code}
          copy={copy}
          error={codeError}
          expired={expired}
          onChange={setCode}
          prepareFailed={prepareFailed}
          preparing={preparing}
        />
        <Button
          aria-busy={resending}
          aria-label={resendLabel}
          className={cn(
            "w-full text-[13px]",
            !prepareFailed && !expired && "h-auto p-0 leading-[17px]",
            AUTH_V2_LINK_ACTION_CLASS,
          )}
          disabled={operationPending || (coolingDown && !expired)}
          type="button"
          variant={prepareFailed || expired ? "outline" : "link"}
          onClick={handleResend}
        >
          {resending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            resendLabel
          )}
        </Button>
      </div>
      {showsCodeInput ? (
        <AuthV2SubmitButton
          busy={submitting}
          disabled={operationPending || expired}
          label={copy.continue}
        />
      ) : null}
    </form>
  );
}

function LoadingStep({ copy }: { readonly copy: AuthV2SignUpCopy }) {
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

function RestartAction({
  copy,
  signals,
  variant,
}: SignUpStepProps & { readonly variant: "ghost" | "outline" }) {
  const pageSignal = useGet(pageSignal$);
  const [restartLoadable, restart] = useLoadableSet(signals.restart$);
  const restarting = restartLoadable.state === "loading";
  return (
    <Button
      aria-busy={restarting}
      aria-label={copy.restart}
      className={cn("w-full", variant === "ghost" && AUTH_V2_LINK_ACTION_CLASS)}
      disabled={restarting}
      type="button"
      variant={variant}
      onClick={() => {
        detach(
          restart(pageSignal),
          Reason.DomCallback,
          "restart auth v2 sign up",
        );
      }}
    >
      {restarting ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        copy.restart
      )}
    </Button>
  );
}

function TransferStep({ copy, signInHref, signals }: SignUpStepProps) {
  return (
    <div className="space-y-3">
      <Button className={cn("w-full", AUTH_V2_PRIMARY_ACTION_CLASS)} asChild>
        <SignInLink signInHref={signInHref}>{copy.signIn}</SignInLink>
      </Button>
      <RestartAction
        copy={copy}
        signInHref={signInHref}
        signals={signals}
        variant="ghost"
      />
    </div>
  );
}

function UnknownStep({ copy, signInHref, signals }: SignUpStepProps) {
  return (
    <div className="space-y-4 text-center">
      <RestartAction
        copy={copy}
        signInHref={signInHref}
        signals={signals}
        variant="outline"
      />
      <Button
        className={cn("w-full", AUTH_V2_LINK_ACTION_CLASS)}
        asChild
        variant="ghost"
      >
        <SignInLink signInHref={signInHref}>{copy.signIn}</SignInLink>
      </Button>
    </div>
  );
}

export function SignUpCardContent({
  copy,
  signInHref,
  signals,
  state,
}: SignUpStepProps & { readonly state: AuthV2SignUpState }) {
  if (state.status === "loading") {
    return <LoadingStep copy={copy} />;
  }
  if (state.status === "complete") {
    return <CompleteStep />;
  }
  if (state.status === "transfer") {
    return (
      <TransferStep copy={copy} signInHref={signInHref} signals={signals} />
    );
  }
  if (state.status === "unknown") {
    return (
      <UnknownStep copy={copy} signInHref={signInHref} signals={signals} />
    );
  }
  if (state.step === "email-code") {
    return (
      <EmailCodeStep
        copy={copy}
        signInHref={signInHref}
        signals={signals}
        state={state}
      />
    );
  }
  return (
    <DetailsStep
      copy={copy}
      signInHref={signInHref}
      signals={signals}
      state={state}
    />
  );
}

export function SignUpSwitch({
  copy,
  signInHref,
}: {
  readonly copy: AuthV2SignUpCopy;
  readonly signInHref: string;
}) {
  return (
    <p className="text-center text-sm text-muted-foreground">
      {copy.alreadyHaveAccount}{" "}
      <SignInLink
        className={cn(
          "font-medium underline underline-offset-4",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
        signInHref={signInHref}
      >
        {copy.signIn}
      </SignInLink>
    </p>
  );
}
