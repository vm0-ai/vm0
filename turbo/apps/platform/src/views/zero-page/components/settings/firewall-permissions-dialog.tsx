import { useGet, useSet } from "ccstate-react";
import { useCCState, useCommand } from "ccstate-react/experimental";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  Button,
} from "@vm0/ui";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type FirewallConfig,
} from "@vm0/core";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  getFirewallRefs,
  fetchFirewallConfigByRef$,
  type PermissionPolicy,
} from "../../../../signals/zero-page/settings/firewalls.ts";
import { IconLoader2, IconCheck, IconX, IconClock } from "@tabler/icons-react";

interface FirewallPermission {
  name: string;
  description?: string;
  ruleCount: number;
}

interface FirewallPermissionsDrawerProps {
  connectorType: ConnectorType;
  agentName: string;
  initialPolicies: Record<string, PermissionPolicy>;
  onApply: (ref: string, policies: Record<string, PermissionPolicy>) => void;
  onClose: () => void;
}

function extractPermissions(config: FirewallConfig): FirewallPermission[] {
  const perms: FirewallPermission[] = [];
  for (const api of config.apis) {
    if (!api.permissions) {
      continue;
    }
    for (const p of api.permissions) {
      perms.push({
        name: p.name,
        description: p.description,
        ruleCount: p.rules.length,
      });
    }
  }
  return perms;
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
  { value: "always_allow" as const, label: "Needs approval" },
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
          className={`px-2.5 py-1.5 transition-colors ${
            policy === opt.value
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

function policyIcon(policy: PermissionPolicy) {
  const base = "shrink-0 flex items-center justify-center rounded-full w-4 h-4";
  if (policy === "deny") {
    return (
      <span className={`${base} bg-red-500`}>
        <IconX size={10} stroke={3.5} className="text-white" />
      </span>
    );
  }
  if (policy === "always_allow") {
    return (
      <span className={`${base} bg-amber-500`}>
        <IconClock size={10} stroke={3.5} className="text-white" />
      </span>
    );
  }
  return (
    <span className={`${base} bg-emerald-500`}>
      <IconCheck size={10} stroke={3.5} className="text-white" />
    </span>
  );
}

export function FirewallPermissionsDrawer({
  connectorType,
  agentName,
  initialPolicies,
  onApply,
  onClose,
}: FirewallPermissionsDrawerProps) {
  const refs = getFirewallRefs(connectorType);

  const activeRef$ = useCCState(refs[0] ?? "");
  const activeRef = useGet(activeRef$);
  const setActiveRef = useSet(activeRef$);

  const config$ = useCCState<FirewallConfig | null>(null);
  const config = useGet(config$);

  const loading$ = useCCState(true);
  const loading = useGet(loading$);

  const error$ = useCCState<string | null>(null);
  const errorMsg = useGet(error$);

  const policies$ = useCCState<Record<string, PermissionPolicy>>({});
  const policies = useGet(policies$);
  const setPolicies = useSet(policies$);

  const fetchConfig = useSet(fetchFirewallConfigByRef$);

  const loadConfig = useSet(
    useCommand(({ set }, ref: string) => {
      set(loading$, true);
      set(error$, null);

      fetchConfig(ref)
        .then((cfg: FirewallConfig) => {
          set(config$, cfg);
          const perms = extractPermissions(cfg);
          const defaultPolicies: Record<string, PermissionPolicy> = {};
          for (const p of perms) {
            defaultPolicies[p.name] = initialPolicies[p.name] ?? "allow";
          }
          set(policies$, defaultPolicies);
          set(loading$, false);
        })
        .catch((error: unknown) => {
          set(
            error$,
            error instanceof Error ? error.message : "Failed to load config",
          );
          set(loading$, false);
        });
    }),
  );

  if (!config && !errorMsg && loading) {
    loadConfig(activeRef);
  }

  const permissions = config ? sortPermissions(extractPermissions(config)) : [];

  const counts = { allow: 0, deny: 0, always_allow: 0 };
  for (const p of permissions) {
    const pol = policies[p.name] ?? "allow";
    counts[pol]++;
  }

  const handlePolicyChange = (name: string, policy: PermissionPolicy) => {
    setPolicies({ ...policies, [name]: policy });
  };

  const handleSetAll = (policy: PermissionPolicy) => {
    const next: Record<string, PermissionPolicy> = {};
    for (const p of permissions) {
      next[p.name] = policy;
    }
    setPolicies(next);
  };

  const handleApply = () => {
    onApply(activeRef, policies);
    onClose();
  };

  const handleRefSwitch = (ref: string) => {
    setActiveRef(ref);
    loadConfig(ref);
  };

  const connectorLabel = CONNECTOR_TYPES[connectorType]?.label ?? connectorType;
  const hasMultipleRefs = refs.length > 1;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" aria-describedby={undefined}>
        <SheetHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon type={connectorType} size={24} />
            <SheetTitle className="text-base">
              {connectorLabel} permissions
              <span className="text-sm font-normal text-muted-foreground ml-1">
                for {agentName}
              </span>
            </SheetTitle>
          </div>
        </SheetHeader>

        {hasMultipleRefs && (
          <div className="flex gap-1 border-b border-border pb-2">
            {refs.map((ref) => (
              <button
                key={ref}
                type="button"
                onClick={() => handleRefSwitch(ref)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeRef === ref
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {ref.charAt(0).toUpperCase() + ref.slice(1)}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <IconLoader2
              size={20}
              stroke={1.5}
              className="animate-spin text-muted-foreground"
            />
          </div>
        ) : errorMsg ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-destructive">{errorMsg}</p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-3 min-h-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground mr-1">
                  Set all:
                </span>
                {POLICY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSetAll(opt.value)}
                    className="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {counts.allow > 0 && <span>{counts.allow} allow</span>}
                {counts.always_allow > 0 && (
                  <span>
                    {counts.allow > 0 ? " · " : ""}
                    {counts.always_allow} approval
                  </span>
                )}
                {counts.deny > 0 && (
                  <span>
                    {counts.allow > 0 || counts.always_allow > 0 ? " · " : ""}
                    {counts.deny} deny
                  </span>
                )}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto -mx-6 px-3">
              {permissions.map((perm, idx) => {
                const pol = policies[perm.name] ?? "allow";
                return (
                  <div key={perm.name}>
                    {idx > 0 && (
                      <div className="mx-3 border-t border-border/40" />
                    )}
                    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-muted/50 transition-colors">
                      {policyIcon(pol)}
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
          <Button onClick={handleApply} disabled={loading || !!errorMsg}>
            Apply
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
