// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@vm0/ui";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorFirewall,
  groupPermissionsByCategory,
  isFirewallConnectorType,
  resolveFirewallPolicies,
} from "@vm0/connectors/firewalls";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallConfig,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import type {
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { ConnectorIcon } from "./connector-icons.tsx";
import { permissionGrantExpiryText } from "../../../../signals/permission-allow/permission-grant-expiration.ts";
import type { PermissionPolicy } from "../../../../signals/zero-page/settings/permissions.ts";
import {
  permissionAllPolicies$,
  initPermissionPolicies$,
  resetPermissionPolicies$,
  setPermissionPolicy$,
  setPermissionAllPolicies$,
  permissionScrolled$,
  setPermissionScrolled$,
  permissionExpandedGroups$,
  togglePermissionGroup$,
  applyPermissionPolicies$,
  permissionUnknownPolicy$,
  setPermissionUnknownPolicy$,
  permissionGrantExpirations$,
  setPermissionGrantExpiration$,
  initPermissionGrantExpirations$,
  resetPermissionGrantExpirations$,
} from "../../../../signals/zero-page/settings/permissions-dialog.ts";
import {
  IconCheck,
  IconBan,
  IconChevronRight,
  IconClock,
  IconChevronDown,
  IconArrowBackUp,
} from "@tabler/icons-react";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

interface ConnectorPermission {
  name: string;
  description?: string;
}

interface PermissionsDrawerProps {
  agentId: string;
  connectorType: ConnectorType;
  displayName: string;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  expirationEnabled: boolean;
  readOnly?: boolean;
  onApply: (
    policies: FirewallPolicies,
    expiresInByPermission: Readonly<
      Record<string, UserPermissionGrantExpiresIn>
    >,
  ) => Promise<void>;
  onClose: () => void;
}

function extractPermissions(config: FirewallConfig): ConnectorPermission[] {
  const seen = new Map<string, ConnectorPermission>();
  for (const api of config.apis) {
    if (!api.permissions) {
      continue;
    }
    for (const p of api.permissions) {
      if (!seen.has(p.name)) {
        seen.set(p.name, {
          name: p.name,
          description: p.description,
        });
      }
    }
  }
  return [...seen.values()];
}

function sortPermissions(perms: ConnectorPermission[]): ConnectorPermission[] {
  return [...perms].sort((a, b) => {
    const [aBase, aSuffix] = splitPermName(a.name);
    const [bBase, bSuffix] = splitPermName(b.name);
    const baseCmp = aBase.localeCompare(bBase);
    if (baseCmp !== 0) {
      return baseCmp;
    }
    if (aSuffix === "read" && bSuffix !== "read") {
      return -1;
    }
    if (bSuffix === "read" && aSuffix !== "read") {
      return 1;
    }
    return aSuffix.localeCompare(bSuffix);
  });
}

function splitPermName(name: string): [string, string] {
  const colonIdx = name.lastIndexOf(":");
  if (colonIdx > 0) {
    return [name.slice(0, colonIdx), name.slice(colonIdx + 1)];
  }
  const underIdx = name.lastIndexOf("_");
  if (underIdx > 0) {
    return [name.slice(0, underIdx), name.slice(underIdx + 1)];
  }
  return [name, ""];
}

const POLICY_OPTIONS = [
  { value: "allow" as const, label: "Allow" },
  { value: "deny" as const, label: "Deny" },
] as const;

function getGroupPolicy(
  perms: ConnectorPermission[],
  policies: Record<string, PermissionPolicy>,
): PermissionPolicy | "mixed" {
  if (perms.length === 0) {
    return "allow";
  }
  const first = policies[perms[0].name] ?? "allow";
  for (let i = 1; i < perms.length; i++) {
    if ((policies[perms[i].name] ?? "allow") !== first) {
      return "mixed";
    }
  }
  return first;
}

function PolicyPill({
  policy,
  onChange,
  disabled,
}: {
  policy: FirewallPolicyValue | "mixed";
  onChange?: (p: PermissionPolicy) => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 rounded-md overflow-hidden text-xs font-medium zero-border">
      {POLICY_OPTIONS.map((opt, idx) => {
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-pressed={policy === opt.value}
            style={
              idx > 0
                ? { borderLeft: "0.7px solid hsl(var(--gray-400))" }
                : undefined
            }
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange?.(opt.value);
            }}
            className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors ${
              policy === opt.value
                ? opt.value === "allow"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                : disabled
                  ? "text-muted-foreground/50"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            } ${disabled ? "cursor-default" : "cursor-pointer"}`}
          >
            {opt.value === "allow" && <IconCheck size={12} stroke={2.5} />}
            {opt.value === "deny" && <IconBan size={12} stroke={2.5} />}
            {opt.label}
          </button>
        );
      })}
    </span>
  );
}

function buildSortedGroups(
  config: FirewallConfig | null,
  ref: string,
): { category: string; permissions: ConnectorPermission[] }[] | null {
  if (!config) {
    return null;
  }
  return (
    groupPermissionsByCategory(extractPermissions(config), ref)?.map(
      (group) => {
        return { ...group, permissions: sortPermissions(group.permissions) };
      },
    ) ?? null
  );
}

function permissionDrawerConfig(ref: ConnectorType): FirewallConfig | null {
  return isFirewallConnectorType(ref) ? getConnectorFirewall(ref) : null;
}

function sortedPermissionsForConfig(
  config: FirewallConfig | null,
): ConnectorPermission[] {
  return config ? sortPermissions(extractPermissions(config)) : [];
}

function permissionPolicyRecord(
  permissions: readonly ConnectorPermission[],
  policy: PermissionPolicy,
): Record<string, PermissionPolicy> {
  const next: Record<string, PermissionPolicy> = {};
  for (const permission of permissions) {
    next[permission.name] = policy;
  }
  return next;
}

function buildInitialPolicies(
  ref: string,
  config: FirewallConfig | null,
  initialPolicies: FirewallPolicies,
): Record<string, Record<string, PermissionPolicy>> {
  const result: Record<string, Record<string, PermissionPolicy>> = {};
  if (!config) {
    return result;
  }
  const perms = extractPermissions(config);
  const resolved = resolveFirewallPolicies(initialPolicies, [ref]);
  const refPolicies: Record<string, PermissionPolicy> = {};
  for (const p of perms) {
    refPolicies[p.name] = resolved?.[ref]?.policies[p.name] ?? "allow";
  }
  result[ref] = refPolicies;
  return result;
}

function mergeDrawerPolicies({
  initialPolicies,
  ref,
  policies,
  unknownPolicy,
}: {
  initialPolicies: FirewallPolicies;
  ref: string;
  policies: Record<string, Record<string, PermissionPolicy>>;
  unknownPolicy: FirewallPolicyValue;
}): FirewallPolicies {
  const unified: FirewallPolicies = { ...initialPolicies };
  for (const [r, p] of Object.entries(policies)) {
    const nextUnknownPolicy =
      r === ref ? unknownPolicy : initialPolicies[r]?.unknownPolicy;
    unified[r] =
      nextUnknownPolicy === undefined
        ? { policies: p }
        : { policies: p, unknownPolicy: nextUnknownPolicy };
  }
  return unified;
}

function buildExplicitGrantMap(
  ref: string,
  grants: readonly UserPermissionGrantResponse[],
): Map<string, UserPermissionGrantResponse> {
  const result = new Map<string, UserPermissionGrantResponse>();
  for (const grant of grants) {
    if (grant.connectorRef === ref) {
      result.set(grant.permission, grant);
    }
  }
  return result;
}

function explicitGrantStateKey(
  grants: Map<string, UserPermissionGrantResponse>,
): string {
  return JSON.stringify(
    [...grants.entries()].map(([permission, grant]) => {
      return [permission, grant.action, grant.expiresAt] as const;
    }),
  );
}

function permissionPoliciesEqual(
  a: Record<string, PermissionPolicy>,
  b: Record<string, PermissionPolicy>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of aKeys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function hasPermissionPolicyChanges({
  currentPolicies,
  initialPolicies,
  currentUnknownPolicy,
  initialUnknownPolicy,
}: {
  currentPolicies: Record<string, PermissionPolicy> | undefined;
  initialPolicies: Record<string, PermissionPolicy>;
  currentUnknownPolicy: FirewallPolicyValue;
  initialUnknownPolicy: FirewallPolicyValue;
}): boolean {
  if (currentPolicies === undefined) {
    return false;
  }
  if (currentUnknownPolicy !== initialUnknownPolicy) {
    return true;
  }
  return !permissionPoliciesEqual(currentPolicies, initialPolicies);
}

function hasGrantExpirationChanges({
  expirationEnabled,
  explicitGrants,
  policies,
  unknownPolicy,
  selections,
}: {
  expirationEnabled: boolean;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  policies: Record<string, PermissionPolicy>;
  unknownPolicy: FirewallPolicyValue;
  selections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
}): boolean {
  if (!expirationEnabled) {
    return false;
  }
  for (const permission of Object.keys(selections)) {
    const grant = explicitGrants.get(permission);
    const selected = selections[permission];
    const currentAction =
      permission === UNKNOWN_PERMISSION_GRANT
        ? unknownPolicy
        : (policies[permission] ?? grant?.action ?? "allow");
    if (
      currentAction === "allow" &&
      (grant?.action === "allow" || (!grant && selected !== "always"))
    ) {
      return true;
    }
  }
  return false;
}

function hasPendingGrantExpirationChange({
  expirationEnabled,
  grant,
  policy,
  selected,
}: {
  expirationEnabled: boolean;
  grant: UserPermissionGrantResponse | undefined;
  policy: FirewallPolicyValue;
  selected: UserPermissionGrantExpiresIn | undefined;
}): boolean {
  if (!expirationEnabled || selected === undefined || policy !== "allow") {
    return false;
  }
  if (grant?.action === "allow") {
    return selected !== "always" || Boolean(grant.expiresAt);
  }
  return selected !== "always";
}

function hasPendingPermissionControlChange({
  expirationEnabled,
  grant,
  initialPolicy,
  policy,
  selected,
}: {
  expirationEnabled: boolean;
  grant: UserPermissionGrantResponse | undefined;
  initialPolicy: PermissionPolicy;
  policy: FirewallPolicyValue;
  selected: UserPermissionGrantExpiresIn | undefined;
}): boolean {
  return (
    policy !== initialPolicy ||
    hasPendingGrantExpirationChange({
      expirationEnabled,
      grant,
      policy,
      selected,
    })
  );
}

function canApplyPermissionPolicies({
  config,
  saving,
  hasChanges,
}: {
  config: FirewallConfig | null;
  saving: boolean;
  hasChanges: boolean;
}): boolean {
  return config !== null && !saving && hasChanges;
}

function UnknownEndpointsToggle({
  policyControl,
}: {
  policyControl: ReactNode;
}) {
  return (
    <div className="border-t border-border/40 -mx-6 px-3 pt-3 pb-1">
      <div className="flex items-center justify-between px-3">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-foreground">
            Other endpoints
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
            API endpoints not matched by any permission above
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{policyControl}</div>
      </div>
    </div>
  );
}

function GrantExpirationStatus({
  expiresAt,
  selected,
}: {
  expiresAt: string | null;
  selected: UserPermissionGrantExpiresIn | undefined;
}) {
  const selectedStatus = allowDurationStatusLabel(selected);
  const expiryText =
    selectedStatus ?? compactGrantExpirationText(expiresAt) ?? "Always";
  const hasExpiringGrant =
    selected === undefined ? Boolean(expiresAt) : selected !== "always";

  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-[150px] items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium",
        hasExpiringGrant
          ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <IconClock size={12} className="shrink-0" />
      <span className="truncate">{expiryText}</span>
    </span>
  );
}

const ALLOW_DURATION_MENU_OPTIONS: readonly {
  readonly value: UserPermissionGrantExpiresIn;
  readonly label: string;
  readonly statusLabel: string;
}[] = [
  { value: "1h", label: "Allow for 1h", statusLabel: "1h" },
  { value: "24h", label: "Allow for 24h", statusLabel: "24h" },
  { value: "7d", label: "Allow for 7d", statusLabel: "7d" },
  { value: "always", label: "Allow always", statusLabel: "Always" },
];

function compactGrantExpirationText(expiresAt: string | null): string | null {
  const text = permissionGrantExpiryText(expiresAt);
  if (text === "Expires in less than 1 hour") {
    return "< 1 hour";
  }
  return text?.replace(/^Expires in /, "") ?? null;
}

function allowDurationStatusLabel(
  selected: UserPermissionGrantExpiresIn | undefined,
): string | null {
  const option = ALLOW_DURATION_MENU_OPTIONS.find((item) => {
    return item.value === selected;
  });
  return option?.statusLabel ?? null;
}

function permissionPolicyButtonClass({
  active,
  disabled,
  tone,
}: {
  active: boolean;
  disabled?: boolean;
  tone: "allow" | "deny";
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

function MenuItemCheck({ active }: { active: boolean }) {
  return active ? (
    <IconCheck size={14} stroke={2.5} />
  ) : (
    <span className="h-3.5 w-3.5 shrink-0" />
  );
}

function menuOptionExpiresIn(
  value: UserPermissionGrantExpiresIn,
  allowGrant: UserPermissionGrantResponse | undefined,
): UserPermissionGrantExpiresIn | null {
  if (value === "always" && !allowGrant?.expiresAt) {
    return null;
  }
  return value;
}

function isDurationMenuOptionActive({
  allowAlwaysActive,
  selected,
  value,
}: {
  allowAlwaysActive: boolean;
  selected: UserPermissionGrantExpiresIn | undefined;
  value: UserPermissionGrantExpiresIn;
}): boolean {
  if (selected !== undefined) {
    return selected === value;
  }
  return value === "always" && allowAlwaysActive;
}

function PermissionGrantResetButton({
  disabled,
  permission,
  visible,
  onReset,
}: {
  disabled?: boolean;
  permission: string;
  visible: boolean;
  onReset: () => void;
}) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center">
      {visible && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Undo ${permission} changes`}
                onClick={() => {
                  onReset();
                }}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors ${
                  disabled
                    ? "cursor-default text-muted-foreground/50"
                    : "hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <IconArrowBackUp size={13} stroke={2.2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Undo changes</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  );
}

function PermissionGrantPolicyControl({
  permission,
  policy,
  grant,
  selected,
  hasPendingChange,
  expirationEnabled,
  allowAlwaysActive,
  expirationStatusExpiresAt,
  readOnly,
  saving,
  showCurrentExpirationStatus = true,
  onClearExpiration,
  onAllowDurationChange,
  onPolicyChange,
  onReset,
}: {
  permission: string;
  policy: FirewallPolicyValue | "mixed";
  grant: UserPermissionGrantResponse | undefined;
  selected: UserPermissionGrantExpiresIn | undefined;
  hasPendingChange: boolean;
  expirationEnabled: boolean;
  allowAlwaysActive: boolean;
  expirationStatusExpiresAt?: string | null;
  readOnly?: boolean;
  saving: boolean;
  showCurrentExpirationStatus?: boolean;
  onClearExpiration: () => void;
  onAllowDurationChange: (expiresIn: UserPermissionGrantExpiresIn) => void;
  onPolicyChange: (policy: PermissionPolicy) => void;
  onReset: () => void;
}) {
  const allowGrant = grant?.action === "allow" ? grant : undefined;
  const showExpirationStatus =
    showCurrentExpirationStatus && expirationEnabled && policy === "allow";
  const expirationStatusValue =
    expirationStatusExpiresAt ?? allowGrant?.expiresAt ?? null;
  const showSplitPolicy = expirationEnabled && !readOnly;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {showExpirationStatus && (
        <GrantExpirationStatus
          expiresAt={expirationStatusValue}
          selected={selected}
        />
      )}
      {!showSplitPolicy ? (
        <PolicyPill
          policy={policy}
          disabled={readOnly}
          onChange={(nextPolicy) => {
            onPolicyChange(nextPolicy);
          }}
        />
      ) : (
        <span className="inline-flex shrink-0 overflow-hidden rounded-md text-xs font-medium zero-border">
          <button
            type="button"
            disabled={saving}
            aria-pressed={policy === "allow"}
            onClick={() => {
              onPolicyChange("allow");
            }}
            className={permissionPolicyButtonClass({
              active: policy === "allow",
              disabled: saving,
              tone: "allow",
            })}
          >
            <IconCheck size={12} stroke={2.5} />
            Allow
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={saving}
                aria-label={`${permission} allow options`}
                className={`flex h-7 items-center border-l border-[hsl(var(--gray-400))] px-1.5 transition-colors ${
                  policy === "allow"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : saving
                      ? "text-muted-foreground/50"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                } ${saving ? "cursor-default" : "cursor-pointer"}`}
              >
                <IconChevronDown size={13} stroke={2.5} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {ALLOW_DURATION_MENU_OPTIONS.map((option) => {
                return (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => {
                      onPolicyChange("allow");
                      onAllowDurationChange(option.value);
                    }}
                  >
                    <MenuItemCheck
                      active={isDurationMenuOptionActive({
                        allowAlwaysActive,
                        selected,
                        value: option.value,
                      })}
                    />
                    {option.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            disabled={saving}
            aria-pressed={policy === "deny"}
            style={{ borderLeft: "0.7px solid hsl(var(--gray-400))" }}
            onClick={() => {
              onPolicyChange("deny");
              onClearExpiration();
            }}
            className={permissionPolicyButtonClass({
              active: policy === "deny",
              disabled: saving,
              tone: "deny",
            })}
          >
            <IconBan size={12} stroke={2.5} />
            Deny
          </button>
        </span>
      )}
      {showSplitPolicy && (
        <PermissionGrantResetButton
          disabled={saving}
          permission={permission}
          visible={hasPendingChange}
          onReset={onReset}
        />
      )}
    </div>
  );
}

function groupExpirationSelection(
  permissions: readonly ConnectorPermission[],
  selections: Readonly<Record<string, UserPermissionGrantExpiresIn>>,
): UserPermissionGrantExpiresIn | undefined {
  if (permissions.length === 0) {
    return undefined;
  }
  const first = selections[permissions[0].name];
  if (first === undefined) {
    return undefined;
  }
  for (let i = 1; i < permissions.length; i++) {
    if (selections[permissions[i].name] !== first) {
      return undefined;
    }
  }
  return first;
}

function hasPendingGroupControlChange({
  expirationEnabled,
  explicitGrants,
  initialPolicies,
  permissions,
  policies,
  selections,
}: {
  expirationEnabled: boolean;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  initialPolicies: Record<string, PermissionPolicy>;
  permissions: readonly ConnectorPermission[];
  policies: Record<string, PermissionPolicy>;
  selections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
}): boolean {
  return permissions.some((permission) => {
    const name = permission.name;
    return hasPendingPermissionControlChange({
      expirationEnabled,
      grant: explicitGrants.get(name),
      initialPolicy: initialPolicies[name] ?? "allow",
      policy: policies[name] ?? "allow",
      selected: selections[name],
    });
  });
}

function hasAllowAlwaysPolicy(
  grant: UserPermissionGrantResponse | undefined,
  policy: FirewallPolicyValue,
): boolean {
  return policy === "allow" && !(grant?.action === "allow" && grant.expiresAt);
}

function hasGroupAllowAlwaysPolicy({
  explicitGrants,
  permissions,
  policies,
}: {
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  permissions: readonly ConnectorPermission[];
  policies: Record<string, PermissionPolicy>;
}): boolean {
  return permissions.every((permission) => {
    const name = permission.name;
    return hasAllowAlwaysPolicy(
      explicitGrants.get(name),
      policies[name] ?? "allow",
    );
  });
}

function groupExpirationStatusExpiresAt({
  explicitGrants,
  permissions,
  policies,
}: {
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  permissions: readonly ConnectorPermission[];
  policies: Record<string, PermissionPolicy>;
}): string | null | undefined {
  if (permissions.length === 0) {
    return null;
  }

  let firstExpiresAt: string | null | undefined;
  for (const permission of permissions) {
    const name = permission.name;
    if ((policies[name] ?? "allow") !== "allow") {
      return undefined;
    }

    const grant = explicitGrants.get(name);
    const expiresAt =
      grant?.action === "allow" && grant.expiresAt ? grant.expiresAt : null;
    if (firstExpiresAt === undefined) {
      firstExpiresAt = expiresAt;
      continue;
    }
    if (firstExpiresAt !== expiresAt) {
      return undefined;
    }
  }

  return firstExpiresAt ?? null;
}

function PermissionRows({
  groups,
  permissions,
  initialPolicies,
  policies,
  expandedGroups,
  explicitGrants,
  expirationSelections,
  expirationEnabled,
  readOnly,
  saving,
  onToggleGroup,
  onSetGroupAll,
  onPolicyChange,
  onGrantExpirationChange,
  onResetPermission,
}: {
  groups: { category: string; permissions: ConnectorPermission[] }[] | null;
  permissions: ConnectorPermission[];
  initialPolicies: Record<string, PermissionPolicy>;
  policies: Record<string, PermissionPolicy>;
  expandedGroups: Set<string>;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  expirationSelections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
  expirationEnabled: boolean;
  readOnly?: boolean;
  saving: boolean;
  onToggleGroup: (category: string) => void;
  onSetGroupAll: (
    groupPerms: ConnectorPermission[],
    policy: PermissionPolicy,
  ) => void;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => void;
  onResetPermission: (name: string) => void;
}) {
  if (groups) {
    return groups.map((group, groupIdx) => {
      const expanded = expandedGroups.has(group.category);
      const groupPolicy = getGroupPolicy(group.permissions, policies);
      const groupSelectedExpiration = groupExpirationSelection(
        group.permissions,
        expirationSelections,
      );
      const groupHasPendingChange = hasPendingGroupControlChange({
        expirationEnabled,
        explicitGrants,
        initialPolicies,
        permissions: group.permissions,
        policies,
        selections: expirationSelections,
      });
      const groupAllowAlwaysActive = hasGroupAllowAlwaysPolicy({
        explicitGrants,
        permissions: group.permissions,
        policies,
      });
      const groupExpirationStatus = groupExpirationStatusExpiresAt({
        explicitGrants,
        permissions: group.permissions,
        policies,
      });
      return (
        <div key={group.category}>
          {groupIdx > 0 && (
            <div className="mx-3 border-t border-border/40 my-1" />
          )}
          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              onClick={() => {
                onToggleGroup(group.category);
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-foreground/80 transition-colors"
            >
              <IconChevronRight
                size={14}
                stroke={2}
                className={`transition-transform ${expanded ? "rotate-90" : ""}`}
              />
              {group.category} ({group.permissions.length})
            </button>
            <PermissionGrantPolicyControl
              permission={group.category}
              policy={groupPolicy}
              grant={undefined}
              selected={groupSelectedExpiration}
              hasPendingChange={groupHasPendingChange}
              expirationEnabled={expirationEnabled}
              allowAlwaysActive={groupAllowAlwaysActive}
              expirationStatusExpiresAt={groupExpirationStatus ?? null}
              readOnly={readOnly}
              saving={saving}
              showCurrentExpirationStatus={groupExpirationStatus !== undefined}
              onClearExpiration={() => {
                for (const permission of group.permissions) {
                  onGrantExpirationChange(permission.name, null);
                }
              }}
              onAllowDurationChange={(expiresIn) => {
                for (const permission of group.permissions) {
                  const grant = explicitGrants.get(permission.name);
                  onGrantExpirationChange(
                    permission.name,
                    menuOptionExpiresIn(
                      expiresIn,
                      grant?.action === "allow" ? grant : undefined,
                    ),
                  );
                }
              }}
              onPolicyChange={(p) => {
                onSetGroupAll(group.permissions, p);
              }}
              onReset={() => {
                for (const permission of group.permissions) {
                  onResetPermission(permission.name);
                }
              }}
            />
          </div>
          {expanded &&
            group.permissions.map((perm, idx) => {
              return (
                <PermissionRow
                  key={perm.name}
                  permission={perm}
                  showSeparator={idx > 0}
                  indent
                  initialPolicy={initialPolicies[perm.name] ?? "allow"}
                  policies={policies}
                  explicitGrants={explicitGrants}
                  expirationSelections={expirationSelections}
                  expirationEnabled={expirationEnabled}
                  readOnly={readOnly}
                  saving={saving}
                  onPolicyChange={onPolicyChange}
                  onGrantExpirationChange={onGrantExpirationChange}
                  onResetPermission={onResetPermission}
                />
              );
            })}
        </div>
      );
    });
  }

  return permissions.map((perm, idx) => {
    return (
      <PermissionRow
        key={perm.name}
        permission={perm}
        showSeparator={idx > 0}
        initialPolicy={initialPolicies[perm.name] ?? "allow"}
        policies={policies}
        explicitGrants={explicitGrants}
        expirationSelections={expirationSelections}
        expirationEnabled={expirationEnabled}
        readOnly={readOnly}
        saving={saving}
        onPolicyChange={onPolicyChange}
        onGrantExpirationChange={onGrantExpirationChange}
        onResetPermission={onResetPermission}
      />
    );
  });
}

function PermissionRow({
  permission,
  showSeparator,
  indent,
  initialPolicy,
  policies,
  explicitGrants,
  expirationSelections,
  expirationEnabled,
  readOnly,
  saving,
  onPolicyChange,
  onGrantExpirationChange,
  onResetPermission,
}: {
  permission: ConnectorPermission;
  showSeparator: boolean;
  indent?: boolean;
  initialPolicy: PermissionPolicy;
  policies: Record<string, PermissionPolicy>;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  expirationSelections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
  expirationEnabled: boolean;
  readOnly?: boolean;
  saving: boolean;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => void;
  onResetPermission: (name: string) => void;
}) {
  const policy = policies[permission.name] ?? "allow";
  const grant = explicitGrants.get(permission.name);
  const selected = expirationSelections[permission.name];
  const hasPendingChange = hasPendingPermissionControlChange({
    expirationEnabled,
    grant,
    initialPolicy,
    policy,
    selected,
  });
  return (
    <div>
      {showSeparator && <div className="mx-3 border-t border-border/40" />}
      <div
        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-muted/50 transition-colors ${indent ? "pl-8" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <code className="text-xs font-medium text-foreground truncate block">
            {permission.name}
          </code>
          {permission.description && (
            <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
              {permission.description}
            </p>
          )}
        </div>
        <PermissionGrantPolicyControl
          permission={permission.name}
          policy={policy}
          grant={grant}
          selected={selected}
          hasPendingChange={hasPendingChange}
          expirationEnabled={expirationEnabled}
          allowAlwaysActive={hasAllowAlwaysPolicy(grant, policy)}
          readOnly={readOnly}
          saving={saving}
          onClearExpiration={() => {
            onGrantExpirationChange(permission.name, null);
          }}
          onAllowDurationChange={(expiresIn) => {
            onGrantExpirationChange(
              permission.name,
              menuOptionExpiresIn(
                expiresIn,
                grant?.action === "allow" ? grant : undefined,
              ),
            );
          }}
          onPolicyChange={(p) => {
            onPolicyChange(permission.name, p);
          }}
          onReset={() => {
            onResetPermission(permission.name);
          }}
        />
      </div>
    </div>
  );
}

export function PermissionsDrawer({
  agentId,
  connectorType,
  displayName,
  initialPolicies,
  initialGrants,
  expirationEnabled,
  readOnly,
  onApply,
  onClose,
}: PermissionsDrawerProps) {
  const ref = connectorType;

  const config = permissionDrawerConfig(ref);

  const initialUnknownPolicy = initialPolicies[ref]?.unknownPolicy ?? "allow";
  const initialPolicyState = buildInitialPolicies(ref, config, initialPolicies);
  const explicitGrants = buildExplicitGrantMap(ref, initialGrants);
  const grantStateKey = explicitGrantStateKey(explicitGrants);
  const initialPolicyKey = `${agentId}\u0000${ref}\u0000${initialUnknownPolicy}\u0000${JSON.stringify(initialPolicyState[ref] ?? {})}\u0000${grantStateKey}`;
  useSet(initPermissionPolicies$)(
    initialPolicyKey,
    initialPolicyState,
    initialUnknownPolicy,
  );
  useSet(initPermissionGrantExpirations$)(initialPolicyKey, {});

  const allPolicies = useGet(permissionAllPolicies$);
  const unknownPolicy = useGet(permissionUnknownPolicy$);
  const setUnknownPolicy = useSet(setPermissionUnknownPolicy$);
  const scrolled = useGet(permissionScrolled$);
  const setScrolled = useSet(setPermissionScrolled$);
  const expandedGroups = useGet(permissionExpandedGroups$);
  const toggleGroup = useSet(togglePermissionGroup$);
  const setPolicyFn = useSet(setPermissionPolicy$);
  const setAllPoliciesFn = useSet(setPermissionAllPolicies$);
  const expirationSelections = useGet(permissionGrantExpirations$);
  const setGrantExpiration = useSet(setPermissionGrantExpiration$);
  const resetPermissionPolicies = useSet(resetPermissionPolicies$);
  const resetGrantExpirations = useSet(resetPermissionGrantExpirations$);
  const [applyLoadable, applyFn] = useLoadableSet(applyPermissionPolicies$);
  const saving = applyLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const permissions = sortedPermissionsForConfig(config);
  const policiesForRef = allPolicies[ref];
  const policies = policiesForRef ?? {};
  const initialPoliciesForRef = initialPolicyState[ref] ?? {};
  const groups = buildSortedGroups(config, ref);
  const hasPermissionChanges = hasPermissionPolicyChanges({
    currentPolicies: policiesForRef,
    initialPolicies: initialPoliciesForRef,
    currentUnknownPolicy: unknownPolicy,
    initialUnknownPolicy,
  });
  const hasExpirationChanges = hasGrantExpirationChanges({
    expirationEnabled,
    explicitGrants,
    policies,
    unknownPolicy,
    selections: expirationSelections,
  });
  const canApply = canApplyPermissionPolicies({
    config,
    saving,
    hasChanges: hasPermissionChanges || hasExpirationChanges,
  });
  const unknownGrant = explicitGrants.get(UNKNOWN_PERMISSION_GRANT);
  const unknownSelectedExpiration =
    expirationSelections[UNKNOWN_PERMISSION_GRANT];

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setPolicyFn(ref, name, policy);
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    setAllPoliciesFn(ref, permissionPolicyRecord(permissions, policy));
    setUnknownPolicy(policy);
    if (policy === "deny") {
      for (const permission of permissions) {
        setGrantExpiration(permission.name, null);
      }
      setGrantExpiration(UNKNOWN_PERMISSION_GRANT, null);
    }
  };

  const handleSetGroupAll = (
    groupPerms: ConnectorPermission[],
    policy: PermissionPolicy,
  ) => {
    setAllPoliciesFn(ref, {
      ...policies,
      ...permissionPolicyRecord(groupPerms, policy),
    });
    if (policy === "deny") {
      for (const permission of groupPerms) {
        setGrantExpiration(permission.name, null);
      }
    }
  };

  const handleResetPermission = (name: string) => {
    setPolicyFn(ref, name, initialPoliciesForRef[name] ?? "allow");
    setGrantExpiration(name, null);
  };

  const handleResetUnknownPermission = () => {
    setUnknownPolicy(initialUnknownPolicy);
    setGrantExpiration(UNKNOWN_PERMISSION_GRANT, null);
  };

  const handleClose = () => {
    resetPermissionPolicies(initialPolicyKey);
    resetGrantExpirations(initialPolicyKey);
    onClose();
  };

  const handleApply = () => {
    const wrappedApply = async (
      perms: Record<string, Record<string, PermissionPolicy>>,
      unknownFlag: FirewallPolicyValue,
    ): Promise<void> => {
      await onApply(
        mergeDrawerPolicies({
          initialPolicies,
          ref,
          policies: perms,
          unknownPolicy: unknownFlag,
        }),
        expirationSelections,
      );
    };
    detach(
      applyFn(
        { formKey: initialPolicyKey, ref },
        wrappedApply,
        handleClose,
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const connectorLabel = CONNECTOR_TYPES[connectorType]?.label ?? connectorType;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        return !open && handleClose();
      }}
    >
      <SheetContent side="right">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={connectorType} size={24} />
            <SheetTitle className="text-base">
              {connectorLabel} permissions
              <span className="text-sm font-normal text-muted-foreground ml-1">
                for {displayName}
              </span>
            </SheetTitle>
          </div>
          <SheetDescription>
            Configure which actions this agent is allowed to perform via this
            connector.
          </SheetDescription>
        </SheetHeader>

        {!config ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-destructive">
              No permission config found for {ref}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            {!groups && (
              <div
                className={`flex items-center justify-between pb-3 -mx-6 px-6 pr-9 transition-shadow ${scrolled ? "shadow-[0_4px_8px_-4px_rgba(0,0,0,0.08)]" : ""}`}
              >
                <span className="text-xs font-medium text-foreground">
                  {readOnly ? "Permissions" : "Select all"} (
                  {permissions.length})
                </span>
                {!readOnly && (
                  <PolicyPill
                    policy={getGroupPolicy(permissions, policies)}
                    onChange={handleSetAll}
                  />
                )}
              </div>
            )}

            <div
              className={`flex-1 overflow-y-auto -mx-6 px-3 ${groups ? "pt-1" : ""}`}
              onScroll={(e) => {
                const target = e.currentTarget;
                setScrolled(target.scrollTop > 0);
              }}
            >
              <PermissionRows
                groups={groups}
                permissions={permissions}
                initialPolicies={initialPoliciesForRef}
                policies={policies}
                expandedGroups={expandedGroups}
                explicitGrants={explicitGrants}
                expirationSelections={expirationSelections}
                expirationEnabled={expirationEnabled}
                readOnly={readOnly}
                saving={saving}
                onToggleGroup={toggleGroup}
                onSetGroupAll={handleSetGroupAll}
                onPolicyChange={handlePolicyChange}
                onGrantExpirationChange={setGrantExpiration}
                onResetPermission={handleResetPermission}
              />
            </div>

            <UnknownEndpointsToggle
              policyControl={
                <PermissionGrantPolicyControl
                  permission={UNKNOWN_PERMISSION_GRANT}
                  policy={unknownPolicy}
                  grant={unknownGrant}
                  selected={unknownSelectedExpiration}
                  hasPendingChange={hasPendingPermissionControlChange({
                    expirationEnabled,
                    grant: unknownGrant,
                    initialPolicy: initialUnknownPolicy,
                    policy: unknownPolicy,
                    selected: unknownSelectedExpiration,
                  })}
                  expirationEnabled={expirationEnabled}
                  allowAlwaysActive={hasAllowAlwaysPolicy(
                    unknownGrant,
                    unknownPolicy,
                  )}
                  readOnly={readOnly}
                  saving={saving}
                  onClearExpiration={() => {
                    setGrantExpiration(UNKNOWN_PERMISSION_GRANT, null);
                  }}
                  onAllowDurationChange={(expiresIn) => {
                    setGrantExpiration(
                      UNKNOWN_PERMISSION_GRANT,
                      menuOptionExpiresIn(
                        expiresIn,
                        unknownGrant?.action === "allow"
                          ? unknownGrant
                          : undefined,
                      ),
                    );
                  }}
                  onPolicyChange={(p) => {
                    setUnknownPolicy(p);
                  }}
                  onReset={handleResetUnknownPermission}
                />
              }
            />
          </div>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={handleClose}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button onClick={handleApply} disabled={!canApply}>
              {saving ? "Saving..." : "Apply"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
