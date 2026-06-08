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
import { PermissionGrantDurationSelect } from "../../../components/permission-grant-duration-select.tsx";
import {
  expiresInFromGrantExpiresAt,
  permissionGrantExpiryText,
} from "../../../../signals/permission-allow/permission-grant-expiration.ts";
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
import { IconCheck, IconBan, IconChevronRight } from "@tabler/icons-react";
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
  policy: PermissionPolicy | "mixed";
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

function buildInitialExpirationSelections(
  grants: Map<string, UserPermissionGrantResponse>,
): Record<string, UserPermissionGrantExpiresIn> {
  const result: Record<string, UserPermissionGrantExpiresIn> = {};
  for (const [permission, grant] of grants) {
    result[permission] = expiresInFromGrantExpiresAt(grant.expiresAt);
  }
  return result;
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
  selections,
}: {
  expirationEnabled: boolean;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  selections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
}): boolean {
  if (!expirationEnabled) {
    return false;
  }
  for (const [permission, grant] of explicitGrants) {
    const selected = selections[permission];
    if (selected && expiresInFromGrantExpiresAt(grant.expiresAt) !== selected) {
      return true;
    }
  }
  return false;
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
  policy,
  disabled,
  expirationControl,
  onChange,
}: {
  policy: PermissionPolicy | "mixed";
  disabled?: boolean;
  expirationControl?: ReactNode;
  onChange: (p: PermissionPolicy) => void;
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
        <div className="flex shrink-0 items-center gap-2">
          {expirationControl}
          <PolicyPill policy={policy} disabled={disabled} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

function PermissionExpirationControl({
  permission,
  grant,
  selected,
  policyChanged,
  expirationEnabled,
  readOnly,
  saving,
  onChange,
}: {
  permission: string;
  grant: UserPermissionGrantResponse | undefined;
  selected: UserPermissionGrantExpiresIn;
  policyChanged: boolean;
  expirationEnabled: boolean;
  readOnly?: boolean;
  saving: boolean;
  onChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn,
  ) => void;
}) {
  if (!expirationEnabled || (!grant && !policyChanged)) {
    return null;
  }

  const expiryText = permissionGrantExpiryText(grant?.expiresAt ?? null);
  if (readOnly && !expiryText) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {expiryText && (
        <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
          {expiryText}
        </span>
      )}
      {!readOnly && (
        <PermissionGrantDurationSelect
          value={selected}
          onValueChange={(value) => {
            onChange(permission, value);
          }}
          disabled={saving}
          ariaLabel={`${permission} grant duration`}
        />
      )}
    </div>
  );
}

function PermissionRows({
  groups,
  permissions,
  policies,
  initialPolicies,
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
}: {
  groups: { category: string; permissions: ConnectorPermission[] }[] | null;
  permissions: ConnectorPermission[];
  policies: Record<string, PermissionPolicy>;
  initialPolicies: Record<string, PermissionPolicy>;
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
    expiresIn: UserPermissionGrantExpiresIn,
  ) => void;
}) {
  if (groups) {
    return groups.map((group, groupIdx) => {
      const expanded = expandedGroups.has(group.category);
      const groupPolicy = getGroupPolicy(group.permissions, policies);
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
            <PolicyPill
              policy={groupPolicy}
              disabled={readOnly}
              onChange={(p) => {
                onSetGroupAll(group.permissions, p);
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
                  policies={policies}
                  initialPolicies={initialPolicies}
                  explicitGrants={explicitGrants}
                  expirationSelections={expirationSelections}
                  expirationEnabled={expirationEnabled}
                  readOnly={readOnly}
                  saving={saving}
                  onPolicyChange={onPolicyChange}
                  onGrantExpirationChange={onGrantExpirationChange}
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
        policies={policies}
        initialPolicies={initialPolicies}
        explicitGrants={explicitGrants}
        expirationSelections={expirationSelections}
        expirationEnabled={expirationEnabled}
        readOnly={readOnly}
        saving={saving}
        onPolicyChange={onPolicyChange}
        onGrantExpirationChange={onGrantExpirationChange}
      />
    );
  });
}

function PermissionRow({
  permission,
  showSeparator,
  indent,
  policies,
  initialPolicies,
  explicitGrants,
  expirationSelections,
  expirationEnabled,
  readOnly,
  saving,
  onPolicyChange,
  onGrantExpirationChange,
}: {
  permission: ConnectorPermission;
  showSeparator: boolean;
  indent?: boolean;
  policies: Record<string, PermissionPolicy>;
  initialPolicies: Record<string, PermissionPolicy>;
  explicitGrants: Map<string, UserPermissionGrantResponse>;
  expirationSelections: Readonly<Record<string, UserPermissionGrantExpiresIn>>;
  expirationEnabled: boolean;
  readOnly?: boolean;
  saving: boolean;
  onPolicyChange: (name: string, policy: PermissionPolicy) => void;
  onGrantExpirationChange: (
    permission: string,
    expiresIn: UserPermissionGrantExpiresIn,
  ) => void;
}) {
  const policy = policies[permission.name] ?? "allow";
  const initialPolicy = initialPolicies[permission.name] ?? "allow";
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
        <PermissionExpirationControl
          permission={permission.name}
          grant={explicitGrants.get(permission.name)}
          selected={expirationSelections[permission.name] ?? "forever"}
          policyChanged={policy !== initialPolicy}
          expirationEnabled={expirationEnabled}
          readOnly={readOnly}
          saving={saving}
          onChange={onGrantExpirationChange}
        />
        <PolicyPill
          policy={policy}
          disabled={readOnly}
          onChange={(p) => {
            onPolicyChange(permission.name, p);
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
  const initialExpirationSelections =
    buildInitialExpirationSelections(explicitGrants);
  const initialPolicyKey = `${agentId}\u0000${ref}\u0000${initialUnknownPolicy}\u0000${JSON.stringify(initialPolicyState[ref] ?? {})}\u0000${JSON.stringify(initialExpirationSelections)}`;
  useSet(initPermissionPolicies$)(
    initialPolicyKey,
    initialPolicyState,
    initialUnknownPolicy,
  );
  useSet(initPermissionGrantExpirations$)(
    initialPolicyKey,
    initialExpirationSelections,
  );

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
  const groups = buildSortedGroups(config, ref);
  const hasPermissionChanges = hasPermissionPolicyChanges({
    currentPolicies: policiesForRef,
    initialPolicies: initialPolicyState[ref] ?? {},
    currentUnknownPolicy: unknownPolicy,
    initialUnknownPolicy,
  });
  const hasExpirationChanges = hasGrantExpirationChanges({
    expirationEnabled,
    explicitGrants,
    selections: expirationSelections,
  });
  const canApply = canApplyPermissionPolicies({
    config,
    saving,
    hasChanges: hasPermissionChanges || hasExpirationChanges,
  });

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setPolicyFn(ref, name, policy);
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    setAllPoliciesFn(ref, permissionPolicyRecord(permissions, policy));
    setUnknownPolicy(policy);
  };

  const handleSetGroupAll = (
    groupPerms: ConnectorPermission[],
    policy: PermissionPolicy,
  ) => {
    setAllPoliciesFn(ref, {
      ...policies,
      ...permissionPolicyRecord(groupPerms, policy),
    });
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
                policies={policies}
                initialPolicies={initialPolicyState[ref] ?? {}}
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
              />
            </div>

            <UnknownEndpointsToggle
              policy={unknownPolicy}
              disabled={readOnly}
              expirationControl={
                <PermissionExpirationControl
                  permission={UNKNOWN_PERMISSION_GRANT}
                  grant={explicitGrants.get(UNKNOWN_PERMISSION_GRANT)}
                  selected={
                    expirationSelections[UNKNOWN_PERMISSION_GRANT] ?? "forever"
                  }
                  policyChanged={unknownPolicy !== initialUnknownPolicy}
                  expirationEnabled={expirationEnabled}
                  readOnly={readOnly}
                  saving={saving}
                  onChange={setGrantExpiration}
                />
              }
              onChange={(p) => {
                setUnknownPolicy(p);
              }}
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
