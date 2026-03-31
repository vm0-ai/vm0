import { useState } from "react";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { Button } from "@vm0/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCheck,
  IconBan,
  IconShieldLock,
  IconAlertTriangle,
  IconClock,
} from "@tabler/icons-react";
import {
  isFirewallConnectorType,
  CONNECTOR_TYPES,
  getDefaultFirewallPolicies,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/core";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  firewallAllowAgentId$,
  firewallAllowRef$,
  firewallAllowPermission$,
  firewallAllowMethod$,
  firewallAllowPath$,
  firewallAllowAgent$,
  firewallAccessRequests$,
  extractPermissions,
  saveFirewallPolicies$,
  resolveAccessRequest$,
  createAccessRequest$,
} from "../../signals/firewall-allow/firewall-allow-signals.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { detach, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// PolicyPill
// ---------------------------------------------------------------------------

const POLICY_OPTIONS = [
  { value: "allow" as const, label: "Allow" },
  { value: "deny" as const, label: "Deny" },
] as const;

function PolicyPill({
  policy,
  onChange,
  disabled,
}: {
  policy: FirewallPolicyValue;
  onChange?: (p: FirewallPolicyValue) => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 rounded-md overflow-hidden text-xs font-medium zero-border">
      {POLICY_OPTIONS.map((opt, idx) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
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
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Focused single-permission admin view
// ---------------------------------------------------------------------------

function AdminFocusedView({
  agentId,
  ref,
  permission,
  agent,
  method,
  path,
}: {
  agentId: string;
  ref: string;
  permission: { name: string; description?: string };
  agent: { firewallPolicies: FirewallPolicies | null };
  method: string | null;
  path: string | null;
}) {
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;
  const pageSignal = useGet(pageSignal$);
  const requestsLoadable = useLastLoadable(firewallAccessRequests$);
  const setSavePolicies = useSet(saveFirewallPolicies$);
  const setResolveRequest = useSet(resolveAccessRequest$);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const currentPolicy =
    agent.firewallPolicies?.[ref]?.[permission.name] ??
    defaults?.[permission.name] ??
    "allow";
  const [policy, setPolicy] = useState<FirewallPolicyValue>(currentPolicy);

  const handleSave = () => {
    const fullPolicies: FirewallPolicies = {
      ...agent.firewallPolicies,
      [ref]: {
        ...agent.firewallPolicies?.[ref],
        [permission.name]: policy,
      },
    };
    setSaving(true);
    setSaved(false);
    detach(
      setSavePolicies(agentId, fullPolicies, pageSignal)
        .then(() => setSaved(true))
        .finally(() => setSaving(false)),
      Reason.DomCallback,
    );
  };

  const handleResolve = (requestId: string, action: "approve" | "reject") => {
    setResolvingId(requestId);
    detach(
      setResolveRequest(requestId, action, pageSignal)
        .then(() => {
          if (action === "approve") {
            setPolicy("allow");
          }
        })
        .finally(() => setResolvingId(null)),
      Reason.DomCallback,
    );
  };

  const requests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const isDirty = policy !== currentPolicy;

  return (
    <div className="flex flex-col gap-4">
      {/* Blocked request context */}
      {method && path && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
          <p className="text-xs text-amber-800 dark:text-amber-200 flex items-center gap-1.5">
            <IconAlertTriangle size={13} />
            Blocked:{" "}
            <code className="font-mono font-medium">
              {method} {path}
            </code>
          </p>
        </div>
      )}

      {/* Permission card */}
      <div className="zero-border rounded-lg px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <code className="text-sm font-medium text-foreground">
              {permission.name}
            </code>
            {permission.description && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {permission.description}
              </p>
            )}
          </div>
          <PolicyPill policy={policy} onChange={setPolicy} />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || (!isDirty && !saved)}
          >
            {saving ? "Saving..." : saved && !isDirty ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      {/* Pending access requests */}
      {requests.length > 0 && (
        <div className="zero-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-muted/30 border-b border-border/40">
            <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <IconClock size={12} />
              Pending Requests ({requests.length})
            </h3>
          </div>
          {requests.map((req, idx) => (
            <div key={req.id}>
              {idx > 0 && <div className="border-t border-border/40" />}
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-foreground">
                    {req.requesterName ?? req.requesterUserId}
                  </span>
                  {req.reason && (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      &mdash; <span className="italic">{req.reason}</span>
                    </span>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleResolve(req.id, "reject")}
                    disabled={resolvingId === req.id}
                  >
                    <IconBan size={12} />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleResolve(req.id, "approve")}
                    disabled={resolvingId === req.id}
                  >
                    <IconCheck size={12} />
                    Approve
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focused single-permission member view
// ---------------------------------------------------------------------------

function MemberFocusedView({
  agentId,
  ref,
  permission,
  method,
  path,
  agent,
}: {
  agentId: string;
  ref: string;
  permission: { name: string; description?: string };
  method: string | null;
  path: string | null;
  agent: { firewallPolicies: FirewallPolicies | null };
}) {
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;
  const pageSignal = useGet(pageSignal$);
  const requestsLoadable = useLastLoadable(firewallAccessRequests$);
  const setCreateRequest = useSet(createAccessRequest$);
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const currentPolicy =
    agent.firewallPolicies?.[ref]?.[permission.name] ??
    defaults?.[permission.name] ??
    "allow";

  const requests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const isPending = requests.some((r) => r.permission === permission.name);

  const handleSubmit = () => {
    setSubmitting(true);
    detach(
      setCreateRequest(
        {
          agentId,
          firewallRef: ref,
          permission: permission.name,
          method: method ?? undefined,
          path: path ?? undefined,
          reason: reason || undefined,
        },
        pageSignal,
      )
        .then(() => {
          setShowForm(false);
          setReason("");
        })
        .finally(() => setSubmitting(false)),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Blocked request context */}
      {method && path && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
          <p className="text-xs text-amber-800 dark:text-amber-200 flex items-center gap-1.5">
            <IconAlertTriangle size={13} />
            Blocked:{" "}
            <code className="font-mono font-medium">
              {method} {path}
            </code>
          </p>
        </div>
      )}

      {/* Permission card */}
      <div className="zero-border rounded-lg px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <code className="text-sm font-medium text-foreground">
              {permission.name}
            </code>
            {permission.description && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {permission.description}
              </p>
            )}
          </div>
          <PolicyPill policy={currentPolicy} disabled />
          {currentPolicy !== "allow" && (
            <>
              {isPending ? (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 shrink-0">
                  <IconClock size={12} />
                  Pending
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowForm(true)}
                >
                  Request Access
                </Button>
              )}
            </>
          )}
        </div>

        {showForm && (
          <div className="mt-3 flex flex-col gap-2 border-t border-border/40 pt-3">
            <textarea
              placeholder="Reason for access (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="text-sm w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setShowForm(false);
                  setReason("");
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List views (fallback when no specific permission in URL)
// ---------------------------------------------------------------------------

function AdminListView({
  agentId,
  ref,
  agent,
}: {
  agentId: string;
  ref: string;
  agent: {
    firewallPolicies: FirewallPolicies | null;
    displayName: string | null;
  };
}) {
  const permissions = extractPermissions(ref);
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;
  const pageSignal = useGet(pageSignal$);
  const setSavePolicies = useSet(saveFirewallPolicies$);
  const [saving, setSaving] = useState(false);

  const [policies, setPolicies] = useState<Record<string, FirewallPolicyValue>>(
    () => {
      const result: Record<string, FirewallPolicyValue> = {};
      for (const p of permissions) {
        result[p.name] =
          agent.firewallPolicies?.[ref]?.[p.name] ??
          defaults?.[p.name] ??
          "allow";
      }
      return result;
    },
  );

  const handleSave = () => {
    const fullPolicies: FirewallPolicies = {
      ...agent.firewallPolicies,
      [ref]: policies,
    };
    setSaving(true);
    detach(
      setSavePolicies(agentId, fullPolicies, pageSignal).finally(() =>
        setSaving(false),
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Permissions</h2>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <div className="zero-border rounded-lg overflow-hidden">
        {permissions.map((perm, idx) => (
          <div key={perm.name}>
            {idx > 0 && <div className="border-t border-border/40" />}
            <div className="flex items-center gap-2.5 px-3 py-2 hover:bg-muted/50 transition-colors">
              <div className="min-w-0 flex-1">
                <code className="text-xs font-medium text-foreground truncate block">
                  {perm.name}
                </code>
                {perm.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {perm.description}
                  </p>
                )}
              </div>
              <PolicyPill
                policy={policies[perm.name] ?? "allow"}
                onChange={(p) =>
                  setPolicies((prev) => ({ ...prev, [perm.name]: p }))
                }
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemberListView({
  ref,
  agent,
}: {
  ref: string;
  agent: { firewallPolicies: FirewallPolicies | null };
}) {
  const permissions = extractPermissions(ref);
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium text-foreground">Permissions</h2>
      <div className="zero-border rounded-lg overflow-hidden">
        {permissions.map((perm, idx) => {
          const currentPolicy =
            agent.firewallPolicies?.[ref]?.[perm.name] ??
            defaults?.[perm.name] ??
            "allow";
          return (
            <div key={perm.name}>
              {idx > 0 && <div className="border-t border-border/40" />}
              <div className="flex items-center gap-2.5 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <code className="text-xs font-medium text-foreground truncate block">
                    {perm.name}
                  </code>
                  {perm.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {perm.description}
                    </p>
                  )}
                </div>
                <PolicyPill policy={currentPolicy} disabled />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function FirewallAllowPage() {
  const agentId = useGet(firewallAllowAgentId$);
  const ref = useGet(firewallAllowRef$);
  const highlightPermission = useGet(firewallAllowPermission$);
  const method = useGet(firewallAllowMethod$);
  const path = useGet(firewallAllowPath$);

  const agentLoadable = useLastLoadable(firewallAllowAgent$);
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);

  if (!agentId || !ref) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <IconAlertTriangle size={24} />
          <p className="text-sm">
            Missing agent ID or firewall ref in URL parameters
          </p>
        </div>
      </div>
    );
  }

  if (!isFirewallConnectorType(ref)) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <IconAlertTriangle size={24} />
          <p className="text-sm">Unknown firewall: {ref}</p>
        </div>
      </div>
    );
  }

  if (
    agentLoadable.state === "loading" ||
    isAdminLoadable.state === "loading"
  ) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading...</p>
      </div>
    );
  }

  if (agentLoadable.state === "hasError") {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <IconAlertTriangle size={24} />
          <p className="text-sm">Failed to load agent</p>
        </div>
      </div>
    );
  }

  const agent = agentLoadable.data;
  if (!agent) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <p className="text-sm">Agent not found</p>
      </div>
    );
  }

  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const connectorLabel = CONNECTOR_TYPES[ref]?.label ?? ref;
  const agentDisplayName = agent.displayName ?? agentId;

  // Find the specific permission if URL specifies one
  const allPermissions = extractPermissions(ref);
  const focusedPermission = highlightPermission
    ? (allPermissions.find((p) => p.name === highlightPermission) ?? null)
    : null;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-2.5">
          <ConnectorIcon type={ref} size={22} />
          <h1 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <IconShieldLock size={15} />
            {connectorLabel} Firewall
          </h1>
          <span className="text-xs text-muted-foreground">
            &middot; {agentDisplayName}
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-6 pb-6">
        {focusedPermission ? (
          isAdmin ? (
            <AdminFocusedView
              agentId={agentId}
              ref={ref}
              permission={focusedPermission}
              agent={agent}
              method={method}
              path={path}
            />
          ) : (
            <MemberFocusedView
              agentId={agentId}
              ref={ref}
              permission={focusedPermission}
              method={method}
              path={path}
              agent={agent}
            />
          )
        ) : isAdmin ? (
          <AdminListView agentId={agentId} ref={ref} agent={agent} />
        ) : (
          <MemberListView ref={ref} agent={agent} />
        )}
      </main>
    </div>
  );
}
