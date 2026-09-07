import { Button, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { Eye, EyeOff } from "lucide-react";

import {
  authV2RevealedPasswordFieldIds$,
  resetAuthV2PasswordFieldOnRef$,
  setAuthV2PasswordFieldRevealed$,
} from "../../signals/auth-v2-presentation.ts";

interface AuthV2PasswordInputProps {
  readonly ariaDescribedBy?: string;
  readonly ariaInvalid?: boolean;
  readonly autoComplete: string;
  readonly hidePasswordLabel: string;
  readonly id: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly required: boolean;
  readonly showPasswordLabel: string;
  readonly value: string;
}

export function AuthV2PasswordInput({
  ariaDescribedBy,
  ariaInvalid,
  autoComplete,
  hidePasswordLabel,
  id,
  name,
  onChange,
  placeholder,
  required,
  showPasswordLabel,
  value,
}: AuthV2PasswordInputProps) {
  const revealed = useGet(authV2RevealedPasswordFieldIds$).has(id);
  const setRevealed = useSet(setAuthV2PasswordFieldRevealed$);
  const resetOnRef = useSet(resetAuthV2PasswordFieldOnRef$);
  const label = revealed ? hidePasswordLabel : showPasswordLabel;

  return (
    <div className="relative">
      <Input
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        autoComplete={autoComplete}
        className="border border-border pr-10"
        id={id}
        name={name}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        placeholder={placeholder}
        ref={resetOnRef}
        required={required}
        type={revealed ? "text" : "password"}
        value={value}
      />
      <Button
        showTooltip
        aria-controls={id}
        aria-label={label}
        aria-pressed={revealed}
        className="absolute top-0 right-0 text-foreground"
        onClick={() => {
          setRevealed(id, !revealed);
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
    </div>
  );
}
