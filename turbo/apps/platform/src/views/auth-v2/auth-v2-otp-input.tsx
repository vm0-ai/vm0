import { cn, Input } from "@okouai/ui";

const AUTH_V2_OTP_LENGTH = 6;

function normalizeOtp(value: string): string {
  return value.replaceAll(/[^0-9]/g, "").slice(0, AUTH_V2_OTP_LENGTH);
}

export function AuthV2OtpInput({
  errorId,
  invalid,
  label,
  name,
  onChange,
  value,
}: {
  readonly errorId?: string;
  readonly invalid: boolean;
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const id = `auth-v2-${name}`;
  const normalizedValue = normalizeOtp(value);
  return (
    <div>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <div className="relative mx-auto w-fit">
        <Input
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid ? true : undefined}
          autoComplete="one-time-code"
          className="peer absolute inset-0 z-10 h-9 w-full cursor-text opacity-0"
          id={id}
          inputMode="numeric"
          maxLength={AUTH_V2_OTP_LENGTH}
          name={name}
          onChange={(event) => {
            onChange(normalizeOtp(event.currentTarget.value));
          }}
          pattern="[0-9]*"
          required
          value={normalizedValue}
        />
        <div
          aria-hidden="true"
          className="flex gap-2 rounded-lg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring"
        >
          {Array.from({ length: AUTH_V2_OTP_LENGTH }, (_, index) => {
            return (
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border border-input bg-background text-sm text-foreground",
                  invalid && "border-destructive",
                )}
                key={index}
              >
                {normalizedValue[index] ?? ""}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
