// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
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
  getConnectorFirewall,
  groupPermissionsByCategory,
  isFirewallConnectorType,
  resolveFirewallPolicies,
  CONNECTOR_TYPES,
  type ConnectorType,
  type FirewallConfig,
  type FirewallPolicies,
} from "@vm0/core";
import { ConnectorIcon } from "./connector-icons.tsx";
import type { PermissionPolicy } from "../../../../signals/zero-page/settings/permissions.ts";
import {
  permissionAllPolicies$,
  initPermissionPolicies$,
  setPermissionPolicy$,
  setPermissionAllPolicies$,
  permissionScrolled$,
  setPermissionScrolled$,
  permissionExpandedGroups$,
  togglePermissionGroup$,
  applyPermissionPolicies$,
  permissionAllowUnknown$,
  setPermissionAllowUnknown$,
} from "../../../../signals/zero-page/settings/permissions-dialog.ts";
import { IconCheck, IconBan, IconChevronRight } from "@tabler/icons-react";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

interface ConnectorPermission {
  name: string;
  description?: string;
}

interface PermissionsDrawerProps {
  connectorType: ConnectorType;
  displayName: string;
  initialPolicies: FirewallPolicies;
  allowUnknown: boolean;
  readOnly?: boolean;
  onApply: (policies: FirewallPolicies, allowUnknown: boolean) => Promise<void>;
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
                ? "bg-muted text-foreground"
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
    refPolicies[p.name] = resolved?.[ref]?.[p.name] ?? "allow";
  }
  result[ref] = refPolicies;
  return result;
}

function UnknownEndpointsToggle({
  policy,
  disabled,
  onChange,
}: {
  policy: PermissionPolicy | "mixed";
  disabled?: boolean;
  onChange: (p: PermissionPolicy) => void;
}) {
  return (
    <div className="border-t border-border/40 mx-3 mt-2 pt-3 pb-1">
      <div className="flex items-center justify-between px-3">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-foreground">
            Unknown endpoints
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
            Endpoints not matching any permission rule above
          </p>
        </div>
        <PolicyPill policy={policy} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

export function PermissionsDrawer({
  connectorType,
  displayName,
  initialPolicies,
  allowUnknown: initialAllowUnknown,
  readOnly,
  onApply,
  onClose,
}: PermissionsDrawerProps) {
  const ref = connectorType;

  const config = isFirewallConnectorType(ref)
    ? getConnectorFirewall(ref)
    : null;

  useSet(initPermissionPolicies$)(
    buildInitialPolicies(ref, config, initialPolicies),
    initialAllowUnknown,
  );

  const allPolicies = useGet(permissionAllPolicies$);
  const allowUnknown = useGet(permissionAllowUnknown$);
  const setAllowUnknown = useSet(setPermissionAllowUnknown$);
  const scrolled = useGet(permissionScrolled$);
  const setScrolled = useSet(setPermissionScrolled$);
  const expandedGroups = useGet(permissionExpandedGroups$);
  const toggleGroup = useSet(togglePermissionGroup$);
  const setPolicyFn = useSet(setPermissionPolicy$);
  const setAllPoliciesFn = useSet(setPermissionAllPolicies$);
  const [applyLoadable, applyFn] = useLoadableSet(applyPermissionPolicies$);
  const saving = applyLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const permissions = config ? sortPermissions(extractPermissions(config)) : [];
  const policies = allPolicies[ref] ?? {};
  const groups = buildSortedGroups(config, ref);

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setPolicyFn(ref, name, policy);
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    const next: Record<string, PermissionPolicy> = {};
    for (const p of permissions) {
      next[p.name] = policy;
    }
    setAllPoliciesFn(ref, next);
    setAllowUnknown(policy === "allow");
  };

  const handleSetGroupAll = (
    groupPerms: ConnectorPermission[],
    policy: PermissionPolicy,
  ) => {
    const next = { ...policies };
    for (const p of groupPerms) {
      next[p.name] = policy;
    }
    setAllPoliciesFn(ref, next);
  };

  const handleApply = () => {
    detach(applyFn(onApply, onClose, pageSignal), Reason.DomCallback);
  };

  const connectorLabel = CONNECTOR_TYPES[connectorType]?.label ?? connectorType;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        return !open && onClose();
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
              {groups
                ? groups.map((group, groupIdx) => {
                    const expanded = expandedGroups.has(group.category);
                    const groupPolicy = getGroupPolicy(
                      group.permissions,
                      policies,
                    );
                    return (
                      <div key={group.category}>
                        {groupIdx > 0 && (
                          <div className="mx-3 border-t border-border/40 my-1" />
                        )}
                        <div className="flex items-center justify-between px-3 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              return toggleGroup(group.category);
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
                              return handleSetGroupAll(group.permissions, p);
                            }}
                          />
                        </div>
                        {expanded &&
                          group.permissions.map((perm, idx) => {
                            const pol = policies[perm.name] ?? "allow";
                            return (
                              <div key={perm.name}>
                                {idx > 0 && (
                                  <div className="mx-3 border-t border-border/40" />
                                )}
                                <div className="flex items-center gap-2.5 px-3 py-2.5 pl-8 rounded-md hover:bg-muted/50 transition-colors">
                                  <div className="min-w-0 flex-1">
                                    <code className="text-xs font-medium text-foreground truncate block">
                                      {perm.name}
                                    </code>
                                    {perm.description && (
                                      <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                                        {perm.description}
                                      </p>
                                    )}
                                  </div>
                                  <PolicyPill
                                    policy={pol}
                                    disabled={readOnly}
                                    onChange={(p) => {
                                      return handlePolicyChange(perm.name, p);
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    );
                  })
                : permissions.map((perm, idx) => {
                    const pol = policies[perm.name] ?? "allow";
                    return (
                      <div key={perm.name}>
                        {idx > 0 && (
                          <div className="mx-3 border-t border-border/40" />
                        )}
                        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-muted/50 transition-colors">
                          <div className="min-w-0 flex-1">
                            <code className="text-xs font-medium text-foreground truncate block">
                              {perm.name}
                            </code>
                            {perm.description && (
                              <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                                {perm.description}
                              </p>
                            )}
                          </div>
                          <PolicyPill
                            policy={pol}
                            disabled={readOnly}
                            onChange={(p) => {
                              return handlePolicyChange(perm.name, p);
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
            </div>

            <UnknownEndpointsToggle
              policy={allowUnknown ? "allow" : "deny"}
              disabled={readOnly}
              onChange={(p) => {
                setAllowUnknown(p === "allow");
              }}
            />
          </div>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button onClick={handleApply} disabled={!config || saving}>
              {saving ? "Saving..." : "Apply"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
