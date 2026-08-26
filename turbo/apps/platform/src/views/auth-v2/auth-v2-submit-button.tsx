import { Button, cn } from "@okouai/ui";
import { Loader2 } from "lucide-react";

import { AUTH_V2_PRIMARY_ACTION_CLASS } from "./auth-v2-action-styles.ts";

export function AuthV2ActionGlyph() {
  return (
    <svg
      className="size-3.5"
      aria-hidden="true"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M9.5 8.25 6 6v4.5z"
        fill="currentColor"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function AuthV2SubmitButton({
  busy,
  disabled = busy,
  label,
  showIdleGlyph = true,
}: {
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly showIdleGlyph?: boolean;
}) {
  return (
    <Button
      aria-busy={busy}
      aria-label={label}
      className={cn("w-full text-[13px]", AUTH_V2_PRIMARY_ACTION_CLASS)}
      disabled={disabled}
      type="submit"
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <>
          {label}
          {showIdleGlyph ? <AuthV2ActionGlyph /> : null}
        </>
      )}
    </Button>
  );
}
