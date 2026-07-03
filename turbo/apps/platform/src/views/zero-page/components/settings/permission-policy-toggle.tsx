import { IconBan, IconCheck, IconCircleHalf2 } from "@tabler/icons-react";

type PermissionPolicyToggleValue = "allow" | "deny";
type PermissionPolicyToggleState =
  | PermissionPolicyToggleValue
  | "ask"
  | "mixed";

export function PermissionPolicyMixedBadge() {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-muted/60 px-2 text-[11px] font-medium text-muted-foreground">
      <IconCircleHalf2 size={12} className="shrink-0" />
      <span>Mixed</span>
    </span>
  );
}

function permissionPolicyButtonClass({
  active,
  disabled,
  tone,
}: {
  active: boolean;
  disabled?: boolean;
  tone: PermissionPolicyToggleValue;
}): string {
  return `flex h-7 items-center gap-1 px-2.5 text-xs font-medium transition-colors ${
    active
      ? tone === "allow"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "bg-rose-500/10 text-rose-700 dark:text-rose-400"
      : disabled
        ? "text-muted-foreground/50"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
  } ${disabled ? "cursor-default" : "cursor-pointer"}`;
}

export function PermissionPolicyToggle({
  disabled,
  policy,
  onAllow,
  onDeny,
}: {
  readonly disabled?: boolean;
  readonly policy: PermissionPolicyToggleState;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
}) {
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-md text-xs font-medium zero-border">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={policy === "allow"}
        onClick={onAllow}
        className={permissionPolicyButtonClass({
          active: policy === "allow",
          disabled,
          tone: "allow",
        })}
      >
        <IconCheck size={12} stroke={2.5} />
        Allow
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={policy === "deny"}
        style={{ borderLeft: "0.7px solid hsl(var(--gray-400))" }}
        onClick={onDeny}
        className={permissionPolicyButtonClass({
          active: policy === "deny",
          disabled,
          tone: "deny",
        })}
      >
        <IconBan size={12} stroke={2.5} />
        Deny
      </button>
    </span>
  );
}
