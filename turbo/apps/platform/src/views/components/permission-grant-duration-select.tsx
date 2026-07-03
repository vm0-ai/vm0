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

export function PermissionGrantDurationSelect({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
}: {
  value: UserPermissionGrantExpiresIn;
  onValueChange: (value: UserPermissionGrantExpiresIn) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
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
