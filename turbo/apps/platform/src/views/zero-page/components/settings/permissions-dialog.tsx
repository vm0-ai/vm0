// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@vm0/ui";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  groupFirewallMetadataPermissionsByCategory,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import {
  UNKNOWN_PERMISSION_GRANT,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/connectors/firewall-types";
import type {
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  clearPermissionDraftInheritedExpiration,
  createPermissionDraftContext,
  explicitGrantStateKey,
  hasAnyPermissionDraftChange,
  hasPermissionDraftDefaultDifference,
  hasPermissionDraftResetPersistedEffect,
  isPermissionDraftPristine,
  permissionDraftInitialPolicyKey,
  permissionDraftMetadataKey,
  resolvePermissionDraftExpiration,
  resolvePermissionDraftGroupExpiration,
  resolvePermissionDraftListPolicy,
  resolvePermissionDraftPolicy,
  resolvePermissionDraftUnknownPolicy,
  setPermissionDraftConnectorPolicy,
  setPermissionDraftExpiration,
  setPermissionDraftGroupAllowExpiration,
  setPermissionDraftGroupAllowPolicy,
  setPermissionDraftGroupPolicy,
  setPermissionDraftPolicy,
  setPermissionDraftUnknownExpiration,
  setPermissionDraftUnknownPolicy,
  stagePermissionDraftConnectorRestore,
  type PermissionDraftContext,
  type PermissionDraftIntent,
} from "../../../../signals/zero-page/settings/permission-draft-intent.ts";
import { permissionGrantExpiryText } from "../../../../signals/permission-allow/permission-grant-expiration.ts";
import {
  applyPermissionDrawer$,
  permissionDrawerUiState$,
  permissionDrawerUiStateForKey,
  resetPermissionDrawerState$,
  setPermissionDrawerScrolled$,
  setPermissionDrawerSearch$,
  showMorePermissionDrawerRows$,
  togglePermissionDrawerGroup$,
  updatePermissionDrawerDraft$,
} from "../../../../signals/zero-page/settings/permissions-dialog.ts";
import type { PermissionPolicy } from "../../../../signals/zero-page/settings/permissions.ts";
import {
  IconCheck,
  IconBan,
  IconChevronRight,
  IconClock,
  IconChevronDown,
  IconLoader2,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import {
  PermissionPolicyMixedBadge,
  PermissionPolicyToggle,
} from "./permission-policy-toggle.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { firewallPermissionMetadataByConnector } from "../../../../signals/firewall-permission-metadata.ts";

interface ConnectorPermission {
  name: string;
  description?: string;
}

interface PermissionsDrawerProps {
  agentId: string;
  targetKind?: "agent" | "workflow";
  connectorType: ConnectorType;
  displayName: string;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  initialIntent?: PermissionDraftIntent;
  initialSearch?: string;
  initialContextKey?: string;
  resetEnabled?: boolean;
  readOnly?: boolean;
  onApply: (
    intent: PermissionDraftIntent,
    options: PermissionDrawerApplyOptions,
  ) => Promise<void>;
  onClose: () => void;
}

interface PermissionDrawerApplyOptions {
  readonly metadata: FirewallPermissionDetailMetadata;
}

type PermissionsSurface = "sheet" | "dialog";

interface PermissionsDrawerFooterProps {
  readonly surface: PermissionsSurface;
  readonly readOnly?: boolean;
  readonly resetEnabled?: boolean;
  readonly canReset: boolean;
  readonly resetAvailable: boolean;
  readonly saving: boolean;
  readonly canApply: boolean;
  readonly onReset: () => void;
  readonly onClose: () => void;
  readonly onApply: () => void;
}

interface InitialPermissionDrawerState {
  readonly ref: ConnectorType;
  readonly explicitGrants: Map<string, UserPermissionGrantResponse>;
  readonly initialPolicyKey: string;
}

type LoadedPermissionsDrawerContentProps = Pick<
  PermissionsDrawerProps,
  | "initialPolicies"
  | "initialIntent"
  | "initialSearch"
  | "initialContextKey"
  | "resetEnabled"
  | "readOnly"
  | "onApply"
  | "onClose"
> & {
  readonly surface: PermissionsSurface;
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly initialState: InitialPermissionDrawerState;
};

function buildInitialPermissionDrawerState({
  agentId,
  connectorType,
  metadata,
  initialPolicies,
  initialGrants,
}: Pick<
  PermissionsDrawerProps,
  "agentId" | "connectorType" | "initialPolicies" | "initialGrants"
> & {
  readonly metadata: FirewallPermissionDetailMetadata;
}): InitialPermissionDrawerState {
  const explicitGrants = buildExplicitGrantMap(connectorType, initialGrants);
  const grantStateKey = explicitGrantStateKey(explicitGrants);
  const context = createPermissionDraftContext({ metadata, initialPolicies });
  const initialPolicyStateKey = permissionDraftInitialPolicyKey(context);
  return {
    ref: connectorType,
    explicitGrants,
    initialPolicyKey: `${agentId}\u0000${connectorType}\u0000${permissionDraftMetadataKey(metadata)}\u0000${initialPolicyStateKey}\u0000${grantStateKey}`,
  };
}

function PermissionsDrawerHeader({
  connectorType,
  displayName,
  targetKind = "agent",
  surface,
}: Pick<
  PermissionsDrawerProps,
  "connectorType" | "displayName" | "targetKind"
> & {
  readonly surface: PermissionsSurface;
}) {
  const connectorLabel = CONNECTOR_TYPES[connectorType].label;
  const title = (
    <>
      {connectorLabel} permissions
      <span className="text-sm font-normal text-muted-foreground ml-1">
        for {displayName}
      </span>
    </>
  );
  const description =
    targetKind === "workflow"
      ? "Configure which actions this workflow is allowed to perform via this connector."
      : "Configure which actions this agent is allowed to perform via this connector.";

  if (surface === "dialog") {
    return (
      <DialogHeader>
        <div className="flex items-center gap-3">
          <ConnectorIcon type={connectorType} size={24} />
          <DialogTitle className="text-base">{title}</DialogTitle>
        </div>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
    );
  }

  return (
    <SheetHeader>
      <div className="flex items-center gap-3">
        <ConnectorIcon type={connectorType} size={24} />
        <SheetTitle className="text-base">{title}</SheetTitle>
      </div>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
  );
}

function sortPermissions(
  perms: readonly ConnectorPermission[],
): ConnectorPermission[] {
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

const PERMISSION_PAGE_SIZE = 100;

function getGroupPolicy(
  context: PermissionDraftContext,
  draft: PermissionDraftIntent,
  perms: ConnectorPermission[],
): PermissionPolicy | "mixed" {
  return resolvePermissionDraftListPolicy({
    context,
    draft,
    permissions: perms,
  });
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
  metadata: FirewallPermissionDetailMetadata,
): { category: string; permissions: ConnectorPermission[] }[] | null {
  return (
    groupFirewallMetadataPermissionsByCategory(
      metadata.permissions,
      metadata,
    )?.map((group) => {
      return { ...group, permissions: sortPermissions(group.permissions) };
    }) ?? null
  );
}

function sortedPermissionsForMetadata(
  metadata: FirewallPermissionDetailMetadata,
): ConnectorPermission[] {
  return sortPermissions(metadata.permissions);
}

function filterPermissionsForSearch(
  permissions: ConnectorPermission[],
  normalizedSearch: string,
): ConnectorPermission[] {
  if (normalizedSearch.length === 0) {
    return permissions;
  }
  return permissions.filter((permission) => {
    return (
      permission.name.toLowerCase().includes(normalizedSearch) ||
      (permission.description?.toLowerCase().includes(normalizedSearch) ??
        false)
    );
  });
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

function hasDraftExpirationSelections({
  context,
  draft,
  permissions,
}: {
  readonly context: PermissionDraftContext;
  readonly draft: PermissionDraftIntent;
  readonly permissions: readonly ConnectorPermission[];
}): boolean {
  if (draft.unknownExpiration !== undefined) {
    return true;
  }
  for (const permission of permissions) {
    if (
      resolvePermissionDraftExpiration({
        context,
        draft,
        permissionName: permission.name,
      }) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function canApplyPermissionPolicies({
  metadata,
  saving,
  hasChanges,
}: {
  metadata: FirewallPermissionDetailMetadata;
  saving: boolean;
  hasChanges: boolean;
}): boolean {
  return metadata.permissionCount > 0 && !saving && hasChanges;
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

function permissionDurationLabel({
  expiresAt,
  selected,
}: {
  expiresAt: string | null;
  selected: UserPermissionGrantExpiresIn | undefined;
}): string {
  return (
    allowDurationStatusLabel(selected) ??
    compactGrantExpirationText(expiresAt) ??
    "Always"
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

function PermissionAllowDurationDropdown({
  permission,
  label,
  selected,
  allowAlwaysActive,
  saving,
  onSelect,
}: {
  permission: string;
  label: string;
  selected: UserPermissionGrantExpiresIn | undefined;
  allowAlwaysActive: boolean;
  saving: boolean;
  onSelect: (expiresIn: UserPermissionGrantExpiresIn) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={`${permission} allow options`}
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium zero-border transition-colors ${
            saving
              ? "cursor-default text-muted-foreground/50"
              : "cursor-pointer text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          }`}
        >
          <IconClock size={12} className="shrink-0" />
          <span className="max-w-[90px] truncate">{label}</span>
          <IconChevronDown size={12} stroke={2.5} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {ALLOW_DURATION_MENU_OPTIONS.map((option) => {
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => {
                onSelect(option.value);
              }}
              className="flex items-center justify-between gap-4"
            >
              {option.label}
              <MenuItemCheck
                active={isDurationMenuOptionActive({
                  allowAlwaysActive,
                  selected,
                  value: option.value,
                })}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PermissionAllowDurationStatic({ label }: { label: string }) {
  return (
    <span className="inline-flex h-6 max-w-[150px] shrink-0 items-center gap-1.5 rounded-md border zero-border bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground">
      <IconClock size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function PermissionGrantPolicyControl({
  permission,
  policy,
  grant,
  selected,
  allowAlwaysActive,
  expirationStatusExpiresAt,
  readOnly,
  saving,
  showCurrentExpirationStatus = true,
  onAllowClick,
  onClearExpiration,
  onAllowDurationChange,
  onPolicyChange,
}: {
  permission: string;
  policy: FirewallPolicyValue | "mixed";
  grant: UserPermissionGrantResponse | undefined;
  selected: UserPermissionGrantExpiresIn | undefined;
  allowAlwaysActive: boolean;
  expirationStatusExpiresAt?: string | null;
  readOnly?: boolean;
  saving: boolean;
  showCurrentExpirationStatus?: boolean;
  onAllowClick?: () => void;
  onClearExpiration: () => void;
  onAllowDurationChange: (expiresIn: UserPermissionGrantExpiresIn) => void;
  onPolicyChange: (policy: PermissionPolicy) => void;
}) {
  const allowGrant = grant?.action === "allow" ? grant : undefined;
  const showExpirationStatus =
    showCurrentExpirationStatus && policy === "allow";
  const expirationStatusValue =
    expirationStatusExpiresAt ?? allowGrant?.expiresAt ?? null;
  const showSplitPolicy = !readOnly;
  const durationLabel = permissionDurationLabel({
    expiresAt: expirationStatusValue,
    selected,
  });

  return (
    <div className="flex shrink-0 items-center gap-2">
      {!showSplitPolicy ? (
        <>
          {showExpirationStatus && (
            <PermissionAllowDurationStatic label={durationLabel} />
          )}
          <PolicyPill
            policy={policy}
            disabled={readOnly}
            onChange={(nextPolicy) => {
              onPolicyChange(nextPolicy);
            }}
          />
        </>
      ) : (
        <>
          {policy === "allow" && (
            <PermissionAllowDurationDropdown
              permission={permission}
              label={durationLabel}
              selected={selected}
              allowAlwaysActive={allowAlwaysActive}
              saving={saving}
              onSelect={(expiresIn) => {
                onAllowDurationChange(expiresIn);
              }}
            />
          )}
          {policy === "mixed" && <PermissionPolicyMixedBadge />}
          <PermissionPolicyToggle
            policy={policy}
            disabled={saving}
            onAllow={() => {
              if (onAllowClick) {
                onAllowClick();
                return;
              }
              onPolicyChange("allow");
            }}
            onDeny={() => {
              onPolicyChange("deny");
              onClearExpiration();
            }}
          />
        </>
      )}
    </div>
  );
}

function hasAllowAlwaysPolicy(
  grant: UserPermissionGrantResponse | undefined,
  policy: FirewallPolicyValue,
): boolean {
  return policy === "allow" && !(grant?.action === "allow" && grant.expiresAt);
}

function ShowMorePermissions({
  remaining,
  onClick,
}: {
  readonly remaining: number;
  readonly onClick: () => void;
}) {
  return (
    <div className="px-3 py-2">
      <Button type="button" variant="outline" className="h-8" onClick={onClick}>
        Show more ({remaining})
      </Button>
    </div>
  );
}

function PermissionGroupHeader({
  context,
  draft,
  category,
  permissions,
  expanded,
  readOnly,
  saving,
  onToggle,
  onGroupAllow,
  onGroupDeny,
  onGroupAllowDuration,
}: {
  context: PermissionDraftContext;
  draft: PermissionDraftIntent;
  category: string;
  permissions: ConnectorPermission[];
  expanded: boolean;
  readOnly?: boolean;
  saving: boolean;
  onToggle: () => void;
  onGroupAllow: () => void;
  onGroupDeny: () => void;
  onGroupAllowDuration: (expiresIn: UserPermissionGrantExpiresIn) => void;
}) {
  const policy = resolvePermissionDraftListPolicy({
    context,
    draft,
    permissions,
  });
  const selected = resolvePermissionDraftGroupExpiration({
    context,
    draft,
    category,
    permissions,
  });
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-foreground/80 transition-colors"
      >
        <IconChevronRight
          size={14}
          stroke={2}
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        {category} ({permissions.length})
      </button>
      {!readOnly && (
        <div className="ml-auto">
          <PermissionGrantPolicyControl
            permission={category}
            policy={policy}
            grant={undefined}
            selected={selected}
            allowAlwaysActive={selected === undefined}
            showCurrentExpirationStatus={false}
            saving={saving}
            onAllowClick={onGroupAllow}
            onClearExpiration={() => {
              // Denying a group already clears its own expiration.
            }}
            onAllowDurationChange={onGroupAllowDuration}
            onPolicyChange={(nextPolicy) => {
              if (nextPolicy === "deny") {
                onGroupDeny();
                return;
              }
              onGroupAllow();
            }}
          />
        </div>
      )}
    </div>
  );
}

function PermissionRows({
  context,
  draft,
  groups,
  permissions,
  expandedGroups,
  visibleCounts,
  explicitGrants,
  readOnly,
  saving,
  onToggleGroup,
  onGroupAllow,
  onGroupDeny,
  onGroupAllowDuration,
  onPolicyChange,
  onGrantExpirationChange,
  onClearInheritedExpiration,
  onShowMore,
}: {
  context: PermissionDraftContext;
  draft: PermissionDraftIntent;
  groups: { category: string; permissions: ConnectorPermission[] }[] | null;
  permissions: ConnectorPermission[];
  expandedGroups: ReadonlySet<string>;
  visibleCounts: Readonly<Record<string, number>>;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  readOnly?: boolean;
  saving: boolean;
  onToggleGroup: (category: string) => void;
  onGroupAllow: (category: string, permissions: ConnectorPermission[]) => void;
  onGroupDeny: (category: string, permissions: ConnectorPermission[]) => void;
  onGroupAllowDuration: (
    category: string,
    permissions: ConnectorPermission[],
    expiresIn: UserPermissionGrantExpiresIn,
  ) => void;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => void;
  onClearInheritedExpiration: (permission: string) => void;
  onShowMore: (key: string) => void;
}) {
  if (groups) {
    return groups.map((group, groupIdx) => {
      const expanded = expandedGroups.has(group.category);
      const groupListKey = `group:${group.category}`;
      const groupVisibleCount =
        visibleCounts[groupListKey] ?? PERMISSION_PAGE_SIZE;
      const visiblePermissions = group.permissions.slice(0, groupVisibleCount);
      const hasMore = visiblePermissions.length < group.permissions.length;
      return (
        <div key={group.category}>
          {groupIdx > 0 && (
            <div className="mx-3 border-t border-border/40 my-1" />
          )}
          <PermissionGroupHeader
            context={context}
            draft={draft}
            category={group.category}
            permissions={group.permissions}
            expanded={expanded}
            readOnly={readOnly}
            saving={saving}
            onToggle={() => {
              onToggleGroup(group.category);
            }}
            onGroupAllow={() => {
              onGroupAllow(group.category, group.permissions);
            }}
            onGroupDeny={() => {
              onGroupDeny(group.category, group.permissions);
            }}
            onGroupAllowDuration={(expiresIn) => {
              onGroupAllowDuration(
                group.category,
                group.permissions,
                expiresIn,
              );
            }}
          />
          {expanded &&
            visiblePermissions.map((perm, idx) => {
              return (
                <PermissionRow
                  key={perm.name}
                  context={context}
                  draft={draft}
                  permission={perm}
                  showSeparator={idx > 0}
                  indent
                  explicitGrants={explicitGrants}
                  readOnly={readOnly}
                  saving={saving}
                  onPolicyChange={onPolicyChange}
                  onGrantExpirationChange={onGrantExpirationChange}
                  onClearInheritedExpiration={onClearInheritedExpiration}
                />
              );
            })}
          {expanded && hasMore && (
            <ShowMorePermissions
              remaining={group.permissions.length - visiblePermissions.length}
              onClick={() => {
                onShowMore(groupListKey);
              }}
            />
          )}
        </div>
      );
    });
  }

  const visibleCount = visibleCounts.permissions ?? PERMISSION_PAGE_SIZE;
  const visiblePermissions = permissions.slice(0, visibleCount);
  return (
    <>
      {visiblePermissions.map((perm, idx) => {
        return (
          <PermissionRow
            key={perm.name}
            context={context}
            draft={draft}
            permission={perm}
            showSeparator={idx > 0}
            explicitGrants={explicitGrants}
            readOnly={readOnly}
            saving={saving}
            onPolicyChange={onPolicyChange}
            onGrantExpirationChange={onGrantExpirationChange}
            onClearInheritedExpiration={onClearInheritedExpiration}
          />
        );
      })}
      {visiblePermissions.length < permissions.length && (
        <ShowMorePermissions
          remaining={permissions.length - visiblePermissions.length}
          onClick={() => {
            onShowMore("permissions");
          }}
        />
      )}
    </>
  );
}

function PermissionRow({
  context,
  draft,
  permission,
  showSeparator,
  indent,
  explicitGrants,
  readOnly,
  saving,
  onPolicyChange,
  onGrantExpirationChange,
  onClearInheritedExpiration,
}: {
  context: PermissionDraftContext;
  draft: PermissionDraftIntent;
  permission: ConnectorPermission;
  showSeparator: boolean;
  indent?: boolean;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  readOnly?: boolean;
  saving: boolean;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => void;
  onClearInheritedExpiration: (permission: string) => void;
}) {
  const policy = resolvePermissionDraftPolicy({
    context,
    draft,
    permissionName: permission.name,
  });
  const grant = explicitGrants.get(permission.name);
  const selected = resolvePermissionDraftExpiration({
    context,
    draft,
    permissionName: permission.name,
  });
  const category = context.metadata.categories?.categories[permission.name];
  const hasGroupExpiration =
    category !== undefined && draft.groupExpirations[category] !== undefined;
  const allowGrant = grant?.action === "allow" ? grant : undefined;
  return (
    <div>
      {showSeparator && <div className="mx-3 border-t border-border/40" />}
      <div
        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-muted/50 transition-colors ${indent ? "pl-8" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <code className="block whitespace-normal break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]">
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
          allowAlwaysActive={hasAllowAlwaysPolicy(grant, policy)}
          readOnly={readOnly}
          saving={saving}
          onAllowClick={() => {
            onPolicyChange(permission.name, "allow");
          }}
          onClearExpiration={() => {
            if (hasGroupExpiration) {
              onClearInheritedExpiration(permission.name);
              return;
            }
            onGrantExpirationChange(permission.name, null);
          }}
          onAllowDurationChange={(expiresIn) => {
            const nextExpiresIn = menuOptionExpiresIn(expiresIn, allowGrant);
            if (
              expiresIn === "always" &&
              nextExpiresIn === null &&
              hasGroupExpiration
            ) {
              onClearInheritedExpiration(permission.name);
              return;
            }
            onGrantExpirationChange(permission.name, nextExpiresIn);
          }}
          onPolicyChange={(p) => {
            onPolicyChange(permission.name, p);
          }}
        />
      </div>
    </div>
  );
}

function PermissionsFooterShell({
  surface,
  className,
  children,
}: {
  readonly surface: PermissionsSurface;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (surface === "dialog") {
    return <DialogFooter className={className}>{children}</DialogFooter>;
  }
  return <SheetFooter className={className}>{children}</SheetFooter>;
}

function PermissionsDrawerFooter({
  surface,
  readOnly,
  resetEnabled,
  canReset,
  resetAvailable,
  saving,
  canApply,
  onReset,
  onClose,
  onApply,
}: PermissionsDrawerFooterProps) {
  const showReset = !readOnly && resetEnabled && canReset;

  if (!showReset) {
    return (
      <PermissionsFooterShell surface={surface}>
        <Button variant="outline" onClick={onClose}>
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {!readOnly && (
          <Button onClick={onApply} disabled={!canApply}>
            {saving ? "Saving..." : "Apply"}
          </Button>
        )}
      </PermissionsFooterShell>
    );
  }

  return (
    <PermissionsFooterShell
      surface={surface}
      className="gap-2 sm:justify-between sm:space-x-0"
    >
      <div>
        <Button
          variant="outline"
          onClick={onReset}
          disabled={saving || !resetAvailable}
        >
          Restore
        </Button>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose}>
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {!readOnly && (
          <Button onClick={onApply} disabled={!canApply}>
            {saving ? "Saving..." : "Apply"}
          </Button>
        )}
      </div>
    </PermissionsFooterShell>
  );
}

function LoadedPermissionsDrawerContent({
  initialPolicies,
  initialIntent,
  initialSearch,
  initialContextKey,
  resetEnabled,
  readOnly,
  onApply,
  onClose,
  surface,
  metadata,
  initialState,
}: LoadedPermissionsDrawerContentProps) {
  const { explicitGrants } = initialState;
  const stateKey = initialContextKey
    ? `${initialState.initialPolicyKey}\u0000${initialContextKey}`
    : initialState.initialPolicyKey;
  const initialUiState = {
    ...(initialIntent ? { draft: initialIntent } : {}),
    ...(initialSearch ? { search: initialSearch } : {}),
  };
  const drawerUiState = permissionDrawerUiStateForKey(
    useGet(permissionDrawerUiState$),
    stateKey,
    initialUiState,
  );
  const setDraft = useSet(updatePermissionDrawerDraft$);
  const toggleGroup = useSet(togglePermissionDrawerGroup$);
  const showMore = useSet(showMorePermissionDrawerRows$);
  const setSearch = useSet(setPermissionDrawerSearch$);
  const setScrolled = useSet(setPermissionDrawerScrolled$);
  const resetPermissionDrawerState = useSet(resetPermissionDrawerState$);
  const [applyLoadable, applyDrawer] = useLoadableSet(applyPermissionDrawer$);
  const pageSignal = useGet(pageSignal$);
  const context = createPermissionDraftContext({ metadata, initialPolicies });
  const draft = drawerUiState.draft;
  const scrolled = drawerUiState.scrolled;
  const expandedGroups = drawerUiState.expandedGroups;
  const visibleCounts = drawerUiState.visibleCounts;
  const search = drawerUiState.search;
  const saving = applyLoadable.state === "loading";

  const effectiveExplicitGrants = draft.resetPending
    ? new Map<string, UserPermissionGrantResponse>()
    : explicitGrants;
  const permissions = sortedPermissionsForMetadata(metadata);
  const groups = buildSortedGroups(metadata);
  const normalizedSearch = search.trim().toLowerCase();
  const searchActive = normalizedSearch.length > 0;
  const displayedPermissions = filterPermissionsForSearch(
    permissions,
    normalizedSearch,
  );
  const displayedGroups = searchActive ? null : groups;
  const unknownPolicy = resolvePermissionDraftUnknownPolicy({ context, draft });
  const draftPristine = isPermissionDraftPristine(draft);
  const hasDefaultPolicyChanges =
    !draftPristine &&
    hasPermissionDraftDefaultDifference({
      context,
      draft,
      permissions,
    });
  const hasExpirationDraftSelections = hasDraftExpirationSelections({
    context,
    draft,
    permissions,
  });
  const resetAvailable =
    explicitGrants.size > 0 ||
    hasDefaultPolicyChanges ||
    hasExpirationDraftSelections;
  const hasResetPersistedEffect = hasPermissionDraftResetPersistedEffect({
    context,
    draft,
    permissions,
    explicitGrants,
  });
  const hasPermissionChanges =
    hasResetPersistedEffect ||
    (!draftPristine &&
      hasAnyPermissionDraftChange({
        context,
        draft,
        permissions,
        explicitGrants,
      }));
  const canApply = canApplyPermissionPolicies({
    metadata,
    saving,
    hasChanges: hasPermissionChanges,
  });
  const unknownGrant = effectiveExplicitGrants.get(UNKNOWN_PERMISSION_GRANT);
  const unknownSelectedExpiration = draft.unknownExpiration;

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftPolicy({
          draft: current,
          permissionName: name,
          policy,
        });
      },
      initialUiState,
    );
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftConnectorPolicy({
          draft: current,
          policy,
          includeUnknown: true,
        });
      },
      initialUiState,
    );
  };

  const handleGroupAllow = (
    category: string,
    groupPermissions: ConnectorPermission[],
  ) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftGroupAllowPolicy({
          draft: current,
          category,
          permissions: groupPermissions,
        });
      },
      initialUiState,
    );
  };

  const handleGroupDeny = (
    category: string,
    groupPermissions: ConnectorPermission[],
  ) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftGroupPolicy({
          draft: current,
          category,
          permissions: groupPermissions,
          policy: "deny",
        });
      },
      initialUiState,
    );
  };

  const handleGroupAllowDuration = (
    category: string,
    groupPermissions: ConnectorPermission[],
    expiresIn: UserPermissionGrantExpiresIn,
  ) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftGroupAllowExpiration({
          draft: current,
          category,
          permissions: groupPermissions,
          explicitGrants: effectiveExplicitGrants,
          expiresIn,
        });
      },
      initialUiState,
    );
  };

  const handleResetConnector = () => {
    setDraft(
      stateKey,
      (current) => {
        return stagePermissionDraftConnectorRestore({ draft: current });
      },
      initialUiState,
    );
  };

  const handleClose = () => {
    resetPermissionDrawerState();
    onClose();
  };

  const handleToggleGroup = (category: string) => {
    toggleGroup(stateKey, category, initialUiState);
  };

  const handleGrantExpirationChange = (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftExpiration({
          draft: current,
          permissionName: permission,
          expiresIn,
        });
      },
      initialUiState,
    );
  };

  const handleClearInheritedExpiration = (permission: string) => {
    setDraft(
      stateKey,
      (current) => {
        return clearPermissionDraftInheritedExpiration({
          draft: current,
          permissionName: permission,
        });
      },
      initialUiState,
    );
  };

  const handleUnknownExpirationChange = (
    expiresIn: UserPermissionGrantExpiresIn | null,
  ) => {
    setDraft(
      stateKey,
      (current) => {
        return setPermissionDraftUnknownExpiration({
          draft: current,
          expiresIn,
        });
      },
      initialUiState,
    );
  };

  const handleShowMore = (key: string) => {
    showMore(stateKey, key, PERMISSION_PAGE_SIZE, initialUiState);
  };

  const handleSearchChange = (value: string) => {
    setSearch(stateKey, value, initialUiState);
  };

  const handleApply = () => {
    if (saving) {
      return;
    }
    detach(
      applyDrawer(
        {
          intent: draft,
          metadata,
          onApply,
          onClose: handleClose,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <div className="flex flex-1 flex-col min-h-0">
        <div
          className={`flex flex-col gap-2 pb-3 -mx-6 px-6 transition-shadow ${scrolled ? "shadow-[0_4px_8px_-4px_rgba(0,0,0,0.08)]" : ""}`}
        >
          <div className="relative w-full">
            <IconSearch
              size={15}
              stroke={1.5}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
            />
            <input
              value={search}
              onChange={(event) => {
                handleSearchChange(event.currentTarget.value);
              }}
              aria-label="Find permissions"
              placeholder="Find permissions..."
              className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  handleSearchChange("");
                }}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Clear permission search"
              >
                <IconX size={13} stroke={1.8} />
              </button>
            )}
          </div>
          {!groups && !searchActive && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                {readOnly ? "Permissions" : "Select all"} ({permissions.length})
              </span>
              {!readOnly && (
                <PolicyPill
                  policy={getGroupPolicy(context, draft, permissions)}
                  onChange={handleSetAll}
                />
              )}
            </div>
          )}
        </div>

        <div
          className={`flex-1 overflow-y-auto -mx-6 px-3 ${displayedGroups ? "pt-1" : ""}`}
          onScroll={(e) => {
            const target = e.currentTarget;
            setScrolled(stateKey, target.scrollTop > 0, initialUiState);
          }}
        >
          {searchActive && displayedPermissions.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              No results for &ldquo;{search.trim()}&rdquo;
            </p>
          ) : (
            <PermissionRows
              context={context}
              draft={draft}
              groups={displayedGroups}
              permissions={displayedPermissions}
              expandedGroups={expandedGroups}
              visibleCounts={visibleCounts}
              explicitGrants={effectiveExplicitGrants}
              readOnly={readOnly}
              saving={saving}
              onToggleGroup={handleToggleGroup}
              onGroupAllow={handleGroupAllow}
              onGroupDeny={handleGroupDeny}
              onGroupAllowDuration={handleGroupAllowDuration}
              onPolicyChange={handlePolicyChange}
              onGrantExpirationChange={handleGrantExpirationChange}
              onClearInheritedExpiration={handleClearInheritedExpiration}
              onShowMore={handleShowMore}
            />
          )}
        </div>

        <UnknownEndpointsToggle
          policyControl={
            <PermissionGrantPolicyControl
              permission={UNKNOWN_PERMISSION_GRANT}
              policy={unknownPolicy}
              grant={unknownGrant}
              selected={unknownSelectedExpiration}
              allowAlwaysActive={hasAllowAlwaysPolicy(
                unknownGrant,
                unknownPolicy,
              )}
              readOnly={readOnly}
              saving={saving}
              onAllowClick={() => {
                setDraft(
                  stateKey,
                  (current) => {
                    return setPermissionDraftUnknownPolicy({
                      draft: current,
                      policy: "allow",
                    });
                  },
                  initialUiState,
                );
              }}
              onClearExpiration={() => {
                handleUnknownExpirationChange(null);
              }}
              onAllowDurationChange={(expiresIn) => {
                handleUnknownExpirationChange(
                  menuOptionExpiresIn(
                    expiresIn,
                    unknownGrant?.action === "allow" ? unknownGrant : undefined,
                  ),
                );
              }}
              onPolicyChange={(p) => {
                setDraft(
                  stateKey,
                  (current) => {
                    return setPermissionDraftUnknownPolicy({
                      draft: current,
                      policy: p,
                    });
                  },
                  initialUiState,
                );
              }}
            />
          }
        />
      </div>

      <PermissionsDrawerFooter
        surface={surface}
        readOnly={readOnly}
        resetEnabled={resetEnabled}
        canReset
        resetAvailable={resetAvailable}
        saving={saving}
        canApply={canApply}
        onReset={handleResetConnector}
        onClose={handleClose}
        onApply={handleApply}
      />
    </>
  );
}

function PermissionsContent({
  props,
  surface,
  onClose,
}: {
  readonly props: PermissionsDrawerProps;
  readonly surface: PermissionsSurface;
  readonly onClose: () => void;
}) {
  const metadataLoadable = useLoadable(
    firewallPermissionMetadataByConnector({
      connectorType: props.connectorType,
    }),
  );
  const loadedMetadata =
    metadataLoadable.state === "hasData" ? metadataLoadable.data : null;
  const loadedInitialState = loadedMetadata
    ? buildInitialPermissionDrawerState({
        agentId: props.agentId,
        connectorType: props.connectorType,
        metadata: loadedMetadata,
        initialPolicies: props.initialPolicies,
        initialGrants: props.initialGrants,
      })
    : null;
  const loading = metadataLoadable.state === "loading";
  const message =
    metadataLoadable.state === "hasError"
      ? "Failed to load permission metadata"
      : `No permission metadata found for ${props.connectorType}`;

  return (
    <>
      <PermissionsDrawerHeader
        connectorType={props.connectorType}
        displayName={props.displayName}
        targetKind={props.targetKind}
        surface={surface}
      />

      {loadedMetadata && loadedInitialState ? (
        <LoadedPermissionsDrawerContent
          key={loadedInitialState.initialPolicyKey}
          {...props}
          surface={surface}
          metadata={loadedMetadata}
          initialState={loadedInitialState}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="flex flex-1 items-center justify-center">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconLoader2 size={16} className="animate-spin" />
                Loading permissions...
              </div>
            ) : (
              <p className="text-sm text-destructive">{message}</p>
            )}
          </div>

          <PermissionsFooterShell surface={surface}>
            <Button variant="outline" onClick={onClose}>
              {props.readOnly ? "Close" : "Cancel"}
            </Button>
          </PermissionsFooterShell>
        </>
      )}
    </>
  );
}

export function PermissionsDrawer(props: PermissionsDrawerProps) {
  const resetPermissionDrawerState = useSet(resetPermissionDrawerState$);
  const handleClose = () => {
    resetPermissionDrawerState();
    props.onClose();
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        return !open && handleClose();
      }}
    >
      <SheetContent side="right">
        <PermissionsContent
          props={props}
          surface="sheet"
          onClose={handleClose}
        />
      </SheetContent>
    </Sheet>
  );
}

export function PermissionsDialog(props: PermissionsDrawerProps) {
  const resetPermissionDrawerState = useSet(resetPermissionDrawerState$);
  const handleClose = () => {
    resetPermissionDrawerState();
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && handleClose();
      }}
    >
      <DialogContent className="!flex h-[min(720px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[760px] !flex-col !overflow-hidden">
        <PermissionsContent
          props={props}
          surface="dialog"
          onClose={handleClose}
        />
      </DialogContent>
    </Dialog>
  );
}
