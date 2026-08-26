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
  const activeIndex = Math.min(normalizedValue.length, AUTH_V2_OTP_LENGTH - 1);
  return (
    <div>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <div className="group relative mx-auto w-fit">
        <Input
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid ? true : undefined}
          autoComplete="one-time-code"
          className="absolute inset-0 z-10 h-9 w-full cursor-text opacity-0"
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
        <div aria-hidden="true" className="flex gap-2">
          {Array.from({ length: AUTH_V2_OTP_LENGTH }, (_, index) => {
            const digit = normalizedValue[index] ?? "";
            const active = index === activeIndex;
            return (
              <span
                className={cn(
                  "relative flex size-9 items-center justify-center rounded-lg border border-border bg-input text-base font-medium text-foreground",
                  invalid && "border-destructive",
                  active &&
                    "group-focus-within:border-ring group-focus-within:ring-[3px] group-focus-within:ring-ring/10",
                )}
                key={index}
              >
                {digit}
                {active ? (
                  <span
                    className={cn(
                      "absolute top-1/2 h-4 w-px -translate-y-1/2 bg-foreground opacity-0 group-focus-within:opacity-100 [animation:auth-v2-otp-caret-blink_1s_step-end_infinite]",
                      digit
                        ? "left-[calc(50%+0.3rem)]"
                        : "left-1/2 -translate-x-1/2",
                    )}
                  />
                ) : null}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
