import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  Button,
} from "@vm0/ui";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
  CONNECTOR_TYPES,
  type ConnectorType,
  type FirewallConfig,
  type FirewallPolicies,
} from "@vm0/core";
import { ConnectorIcon } from "./connector-icons.tsx";
import type { PermissionPolicy } from "../../../../signals/zero-page/settings/firewalls.ts";
import { IconCheck, IconBan } from "@tabler/icons-react";
import { detach, Reason } from "../../../../signals/utils.ts";

interface FirewallPermission {
  name: string;
  description?: string;
}

interface FirewallPermissionsDrawerProps {
  connectorType: ConnectorType;
  displayName: string;
  initialPolicies: FirewallPolicies;
  onApply: (policies: FirewallPolicies) => Promise<void>;
  onClose: () => void;
}

function extractPermissions(config: FirewallConfig): FirewallPermission[] {
  const seen = new Map<string, FirewallPermission>();
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

function sortPermissions(perms: FirewallPermission[]): FirewallPermission[] {
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

function PolicyPill({
  policy,
  onChange,
}: {
  policy: PermissionPolicy;
  onChange: (p: PermissionPolicy) => void;
}) {
  return (
    <span
      className="inline-flex shrink-0 rounded-md overflow-hidden text-xs font-medium"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
    >
      {POLICY_OPTIONS.map((opt, idx) => (
        <button
          key={opt.value}
          type="button"
          style={
            idx > 0
              ? { borderLeft: "0.7px solid hsl(var(--gray-400))" }
              : undefined
          }
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onChange(opt.value);
          }}
          className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors ${
            policy === opt.value
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          {opt.value === "allow" && <IconCheck size={12} stroke={2.5} />}
          {opt.value === "deny" && <IconBan size={12} stroke={2.5} />}
          {opt.label}
        </button>
      ))}
    </span>
  );
}

export function FirewallPermissionsDrawer({
  connectorType,
  displayName,
  initialPolicies,
  onApply,
  onClose,
}: FirewallPermissionsDrawerProps) {
  const ref = connectorType;

  const config = isFirewallConnectorType(ref)
    ? getConnectorFirewall(ref)
    : null;

  // Build policies state
  const [allPolicies, setAllPolicies] = useState(() => {
    const result: Record<string, Record<string, PermissionPolicy>> = {};
    if (config) {
      const perms = extractPermissions(config);
      const refPolicies: Record<string, PermissionPolicy> = {};
      for (const p of perms) {
        refPolicies[p.name] = initialPolicies[ref]?.[p.name] ?? "allow";
      }
      result[ref] = refPolicies;
    }
    return result;
  });

  const [scrolled, setScrolled] = useState(false);
  const [saving, setSaving] = useState(false);
  const permissions = config ? sortPermissions(extractPermissions(config)) : [];
  const policies = allPolicies[ref] ?? {};

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setAllPolicies({
      ...allPolicies,
      [ref]: { ...policies, [name]: policy },
    });
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    const next: Record<string, PermissionPolicy> = {};
    for (const p of permissions) {
      next[p.name] = policy;
    }
    setAllPolicies({ ...allPolicies, [ref]: next });
  };

  const handleApply = () => {
    setSaving(true);
    detach(
      onApply(allPolicies)
        .then(() => {
          onClose();
        })
        .finally(() => {
          setSaving(false);
        }),
      Reason.DomCallback,
    );
  };

  const connectorLabel = CONNECTOR_TYPES[connectorType]?.label ?? connectorType;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" aria-describedby={undefined}>
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
        </SheetHeader>

        {!config ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-destructive">
              No firewall config found for {ref}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <div
              className={`flex items-center justify-between pb-3 -mx-6 px-6 pr-9 transition-shadow ${scrolled ? "shadow-[0_4px_8px_-4px_rgba(0,0,0,0.08)]" : ""}`}
            >
              <span className="text-xs font-medium text-foreground">
                Select all ({permissions.length})
              </span>
              <span
                className="inline-flex shrink-0 rounded-md overflow-hidden text-xs font-medium"
                style={{ border: "0.7px solid hsl(var(--gray-400))" }}
              >
                {POLICY_OPTIONS.map((opt, idx) => (
                  <button
                    key={opt.value}
                    type="button"
                    style={
                      idx > 0
                        ? { borderLeft: "0.7px solid hsl(var(--gray-400))" }
                        : undefined
                    }
                    onClick={() => handleSetAll(opt.value)}
                    className="flex items-center gap-1 px-2.5 py-1.5 transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  >
                    {opt.value === "allow" && (
                      <IconCheck size={12} stroke={2.5} />
                    )}
                    {opt.value === "deny" && <IconBan size={12} stroke={2.5} />}
                    {opt.label}
                  </button>
                ))}
              </span>
            </div>

            <div
              className="flex-1 overflow-y-auto -mx-6 px-3"
              onScroll={(e) => {
                const target = e.currentTarget;
                setScrolled(target.scrollTop > 0);
              }}
            >
              {permissions.map((perm, idx) => {
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
                        onChange={(p) => handlePolicyChange(perm.name, p)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!config || saving}>
            {saving ? "Saving..." : "Apply"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
