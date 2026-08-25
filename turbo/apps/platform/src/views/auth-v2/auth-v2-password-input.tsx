import { Button, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { Eye, EyeOff } from "lucide-react";

import {
  authV2RevealedPasswordFieldIds$,
  resetAuthV2PasswordFieldOnRef$,
  setAuthV2PasswordFieldRevealed$,
} from "../../signals/auth-v2-presentation.ts";

interface AuthV2PasswordInputProps {
  readonly ariaInvalid?: boolean;
  readonly autoComplete: string;
  readonly hidePasswordLabel: string;
  readonly id: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly required: boolean;
  readonly showPasswordLabel: string;
  readonly value: string;
}

export function AuthV2PasswordInput({
  ariaInvalid,
  autoComplete,
  hidePasswordLabel,
  id,
  name,
  onChange,
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
        aria-invalid={ariaInvalid}
        autoComplete={autoComplete}
        className="pr-10"
        id={id}
        name={name}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        ref={resetOnRef}
        required={required}
        type={revealed ? "text" : "password"}
        value={value}
      />
      <Button
        aria-controls={id}
        aria-label={label}
        aria-pressed={revealed}
        className="absolute top-0 right-0 text-muted-foreground"
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
