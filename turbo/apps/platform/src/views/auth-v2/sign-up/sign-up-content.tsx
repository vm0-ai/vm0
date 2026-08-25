import { Button, Checkbox, Input } from "@okouai/ui";
import { Alert, AlertDescription } from "@okouai/ui/components/ui/alert";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import type {
  AuthV2SignUpErrorField,
  AuthV2SignUpFields,
  AuthV2SignUpLegalConfig,
  AuthV2SignUpSignals,
  AuthV2SignUpState,
} from "../../../signals/auth-v2/sign-up-flow.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { Link } from "../../router/link.tsx";
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
  errorField,
  inputMode,
  label,
  name,
  onChange,
  optionalLabel,
  required,
  type = "text",
  value,
}: {
  readonly autoComplete: string;
  readonly errorField: AuthV2SignUpErrorField | null;
  readonly inputMode?: "email" | "numeric";
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly optionalLabel?: string;
  readonly required: boolean;
  readonly type?: "email" | "password" | "text";
  readonly value: string;
}) {
  const id = `auth-v2-sign-up-${name}`;
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        {label}
        {!required && optionalLabel ? (
          <span className="ml-1 font-normal text-muted-foreground">
            ({optionalLabel})
          </span>
        ) : null}
      </label>
      <Input
        aria-invalid={errorField === name}
        autoComplete={autoComplete}
        id={id}
        inputMode={inputMode}
        name={name}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        required={required}
        type={type}
        value={value}
      />
    </div>
  );
}

function FlowErrorAlert({ copy, signals }: SignUpStepProps) {
  const error = useGet(signals.error$);
  if (!error || error.field === "captcha") {
    return null;
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>{signUpErrorMessage(error, copy)}</AlertDescription>
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
      pathname={ROUTES.signInV2}
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
  const tokenPattern =
    /{{\s*(termsOfServiceLink|privacyPolicyLink)\s*\|\|\s*link\((["'])(.*?)\2\)\s*}}/g;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of template.matchAll(tokenPattern)) {
    const index = match.index;
    const token = match[1];
    const label = match[3];
    if (index === undefined || !token || !label) {
      continue;
    }
    if (index > cursor) {
      content.push(template.slice(cursor, index));
    }
    const href =
      token === "termsOfServiceLink" ? legal.termsUrl : legal.privacyPolicyUrl;
    if (href) {
      content.push(
        <a
          className="font-medium underline underline-offset-4"
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
  const errorField = error?.field ?? null;
  const setEmailAddress = useSet(signals.setEmailAddress$);
  const setPassword = useSet(signals.setPassword$);
  const setFirstName = useSet(signals.setFirstName$);
  const setLastName = useSet(signals.setLastName$);
  return (
    <>
      {fields.emailAddress !== "hidden" ? (
        <TextField
          autoComplete="email"
          errorField={errorField}
          inputMode="email"
          label={copy.emailAddressLabel}
          name="email-address"
          onChange={setEmailAddress}
          optionalLabel={copy.optional}
          required={fields.emailAddress === "required"}
          type="email"
          value={emailAddress}
        />
      ) : null}
      {fields.password !== "hidden" ? (
        <TextField
          autoComplete="new-password"
          errorField={errorField}
          label={copy.passwordLabel}
          name="password"
          onChange={setPassword}
          optionalLabel={copy.optional}
          required={fields.password === "required"}
          type="password"
          value={password}
        />
      ) : null}
      {fields.firstName !== "hidden" ? (
        <TextField
          autoComplete="given-name"
          errorField={errorField}
          label={copy.firstNameLabel}
          name="first-name"
          onChange={setFirstName}
          optionalLabel={copy.optional}
          required={fields.firstName === "required"}
          value={firstName}
        />
      ) : null}
      {fields.lastName !== "hidden" ? (
        <TextField
          autoComplete="family-name"
          errorField={errorField}
          label={copy.lastNameLabel}
          name="last-name"
          onChange={setLastName}
          optionalLabel={copy.optional}
          required={fields.lastName === "required"}
          value={lastName}
        />
      ) : null}
    </>
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
      <Alert variant="destructive">
        <AlertDescription>
          {error?.message ??
            (captchaState === "expired"
              ? copy.captchaExpired
              : copy.captchaError)}
        </AlertDescription>
      </Alert>
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
  const googleOAuthAvailable = useGet(signals.googleOAuthAvailable$);
  const captchaState = useGet(signals.captchaState$);
  const error = useGet(signals.error$);
  const setLegalAccepted = useSet(signals.setLegalAccepted$);
  const captchaRef = useSet(signals.captchaRef$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [googleOAuthLoadable, startGoogleOAuth] = useLoadableSet(
    signals.startGoogleOAuth$,
  );
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    detach(submit(pageSignal), Reason.DomCallback, "submit auth v2 sign up");
  };
  const retrying = captchaState === "error" || captchaState === "expired";
  const operationPending =
    submitLoadable.state === "loading" ||
    googleOAuthLoadable.state === "loading";
  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert copy={copy} signals={signals} signInHref={signInHref} />
      {googleOAuthAvailable ? (
        <Button
          className="w-full"
          disabled={operationPending}
          type="button"
          variant="outline"
          onClick={() => {
            detach(
              startGoogleOAuth(pageSignal),
              Reason.DomCallback,
              "start auth v2 Google sign up",
            );
          }}
        >
          {googleOAuthLoadable.state === "loading" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : null}
          {copy.googleMethod}
        </Button>
      ) : null}
      <FieldList copy={copy} fields={state.fields} signals={signals} />
      {state.legal.required ? (
        <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground">
          <Checkbox
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
      ) : null}
      {state.captchaEnabled ? (
        <div
          data-cl-size="flexible"
          data-cl-theme="auto"
          id="clerk-captcha"
          ref={captchaRef}
        />
      ) : null}
      <CaptchaStatus copy={copy} signals={signals} signInHref={signInHref} />
      <SubmitButton
        busy={submitLoadable.state === "loading"}
        disabled={operationPending}
        label={retrying ? copy.retry : copy.continue}
      />
    </form>
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
  const coolingDown = useGet(signals.resendCoolingDown$);
  const pageSignal = useGet(pageSignal$);
  const setCode = useSet(signals.setCode$);
  const backToDetails = useSet(signals.backToDetails$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [resendLoadable, resendCode] = useLoadableSet(signals.resendCode$);
  const preparing = state.verification === "preparing";
  const prepareFailed = state.verification === "prepare-failed";
  const expired = state.verification === "expired";
  const submitting = submitLoadable.state === "loading";
  const resending = resendLoadable.state === "loading";
  const operationPending = preparing || submitting || resending;
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
    <form className="space-y-4" onSubmit={handleSubmit}>
      <FlowErrorAlert copy={copy} signals={signals} signInHref={signInHref} />
      <div className="space-y-1 text-center">
        <h2 className="text-base font-medium text-foreground">
          {copy.emailCodeTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{state.emailAddress}</p>
      </div>
      {preparing ? (
        <div
          className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="animate-spin" aria-hidden="true" />
          {copy.loading}
        </div>
      ) : null}
      {expired ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.codeExpired}</AlertDescription>
        </Alert>
      ) : null}
      {!preparing && !prepareFailed ? (
        <TextField
          autoComplete="one-time-code"
          errorField={error?.field ?? null}
          inputMode="numeric"
          label={copy.codeLabel}
          name="code"
          onChange={setCode}
          required
          value={code}
        />
      ) : null}
      {!preparing && !prepareFailed ? (
        <SubmitButton
          busy={submitting}
          disabled={operationPending || expired}
          label={copy.verify}
        />
      ) : null}
      <Button
        className="h-auto w-full"
        disabled={operationPending || (coolingDown && !expired)}
        type="button"
        variant={prepareFailed || expired ? "outline" : "link"}
        onClick={handleResend}
      >
        {resending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : null}
        {prepareFailed ? copy.retry : resendCodeLabel(coolingDown, copy)}
      </Button>
      <Button
        className="w-full"
        disabled={operationPending}
        type="button"
        variant="ghost"
        onClick={backToDetails}
      >
        {copy.editEmailAddress || copy.back}
      </Button>
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

function CompleteStep({ copy }: { readonly copy: AuthV2SignUpCopy }) {
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

function TransferStep({ copy, signInHref, signals }: SignUpStepProps) {
  const pageSignal = useGet(pageSignal$);
  const [restartLoadable, restart] = useLoadableSet(signals.restart$);
  return (
    <div className="space-y-3">
      <Button className="w-full" asChild>
        <SignInLink signInHref={signInHref}>{copy.signIn}</SignInLink>
      </Button>
      <Button
        className="w-full"
        disabled={restartLoadable.state === "loading"}
        type="button"
        variant="ghost"
        onClick={() => {
          detach(
            restart(pageSignal),
            Reason.DomCallback,
            "restart auth v2 sign up",
          );
        }}
      >
        {copy.restart}
      </Button>
    </div>
  );
}

function UnknownStep({ copy, signInHref, signals }: SignUpStepProps) {
  const pageSignal = useGet(pageSignal$);
  const [restartLoadable, restart] = useLoadableSet(signals.restart$);
  return (
    <div className="space-y-4 text-center">
      <h2 className="text-base font-medium text-foreground">
        {copy.unknownTitle}
      </h2>
      <Button
        className="w-full"
        disabled={restartLoadable.state === "loading"}
        type="button"
        variant="outline"
        onClick={() => {
          detach(
            restart(pageSignal),
            Reason.DomCallback,
            "restart unknown auth v2 sign up",
          );
        }}
      >
        {copy.restart}
      </Button>
      <Button className="w-full" asChild variant="ghost">
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
    return <CompleteStep copy={copy} />;
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
        className="font-medium text-foreground underline underline-offset-4"
        signInHref={signInHref}
      >
        {copy.signIn}
      </SignInLink>
    </p>
  );
}
