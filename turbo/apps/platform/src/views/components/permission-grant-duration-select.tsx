import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import {
  parseUserPermissionGrantExpiresIn,
  USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS,
} from "../../signals/permission-allow/permission-grant-expiration.ts";

const KEEP_CURRENT_EXPIRATION_VALUE = "keep-current";

export function PermissionGrantDurationSelect({
  value,
  onValueChange,
  onClear,
  disabled,
  ariaLabel,
  className,
  showKeepCurrent,
}: {
  value: UserPermissionGrantExpiresIn | null;
  onValueChange: (value: UserPermissionGrantExpiresIn) => void;
  onClear?: () => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  showKeepCurrent?: boolean;
}) {
  return (
    <Select
      value={value ?? KEEP_CURRENT_EXPIRATION_VALUE}
      onValueChange={(nextValue) => {
        if (nextValue === KEEP_CURRENT_EXPIRATION_VALUE) {
          onClear?.();
          return;
        }
        const parsed = parseUserPermissionGrantExpiresIn(nextValue);
        if (parsed) {
          onValueChange(parsed);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn("h-8 w-[116px] rounded-lg text-xs", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {showKeepCurrent && (
          <SelectItem value={KEEP_CURRENT_EXPIRATION_VALUE}>
            Keep current
          </SelectItem>
        )}
        {USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS.map((option) => {
          return (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
