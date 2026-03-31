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
// PolicyPill (reused from firewall-permissions-dialog pattern)
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
// Admin View
// ---------------------------------------------------------------------------

function AdminView({
  agentId,
  ref,
  highlightPermission,
  agent,
}: {
  agentId: string;
  ref: string;
  highlightPermission: string | null;
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
  const requestsLoadable = useLastLoadable(firewallAccessRequests$);
  const setSavePolicies = useSet(saveFirewallPolicies$);
  const setResolveRequest = useSet(resolveAccessRequest$);
  const [saving, setSaving] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

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
      setSavePolicies(agentId, fullPolicies, pageSignal).finally(() => {
        setSaving(false);
      }),
      Reason.DomCallback,
    );
  };

  const handleResolve = (requestId: string, action: "approve" | "reject") => {
    setResolvingId(requestId);
    detach(
      setResolveRequest(requestId, action, pageSignal)
        .then(() => {
          if (action === "approve") {
            // Reflect the approval in local state
            const request =
              requestsLoadable.state === "hasData"
                ? requestsLoadable.data.find((r) => r.id === requestId)
                : null;
            if (request) {
              setPolicies((prev) => ({
                ...prev,
                [request.permission]: "allow",
              }));
            }
          }
        })
        .finally(() => {
          setResolvingId(null);
        }),
      Reason.DomCallback,
    );
  };

  const requests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];

  return (
    <div className="flex flex-col gap-6">
      {/* Permissions list */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-foreground">Permissions</h2>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>

        <div className="zero-border rounded-lg overflow-hidden">
          {permissions.map((perm, idx) => {
            const isHighlighted = perm.name === highlightPermission;
            return (
              <div key={perm.name}>
                {idx > 0 && <div className="border-t border-border/40" />}
                <div
                  className={`flex items-center gap-2.5 px-4 py-3 transition-colors ${
                    isHighlighted
                      ? "bg-yellow-50 dark:bg-yellow-950/20"
                      : "hover:bg-muted/50"
                  }`}
                >
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
                    policy={policies[perm.name] ?? "allow"}
                    onChange={(p) =>
                      setPolicies((prev) => ({ ...prev, [perm.name]: p }))
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Access requests section */}
      {requests.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-foreground mb-3">
            <span className="flex items-center gap-1.5">
              <IconClock size={14} />
              Pending Access Requests ({requests.length})
            </span>
          </h2>

          <div className="zero-border rounded-lg overflow-hidden">
            {requests.map((req, idx) => (
              <div key={req.id}>
                {idx > 0 && <div className="border-t border-border/40" />}
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <code className="text-xs font-medium text-foreground">
                        {req.permission}
                      </code>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Requested by {req.requesterUserId}
                        {req.reason && (
                          <>
                            {" "}
                            &mdash; <span className="italic">{req.reason}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0 ml-3">
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
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member View
// ---------------------------------------------------------------------------

function MemberView({
  agentId,
  ref,
  highlightPermission,
  method,
  path,
  agent,
}: {
  agentId: string;
  ref: string;
  highlightPermission: string | null;
  method: string | null;
  path: string | null;
  agent: { firewallPolicies: FirewallPolicies | null };
}) {
  const permissions = extractPermissions(ref);
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;
  const pageSignal = useGet(pageSignal$);
  const requestsLoadable = useLastLoadable(firewallAccessRequests$);
  const setCreateRequest = useSet(createAccessRequest$);
  const [requestingPermission, setRequestingPermission] = useState<
    string | null
  >(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const requests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const pendingPermissions = new Set(requests.map((r) => r.permission));

  const handleSubmit = (permission: string) => {
    setSubmitting(true);
    detach(
      setCreateRequest(
        {
          agentId,
          firewallRef: ref,
          permission,
          method: method ?? undefined,
          path: path ?? undefined,
          reason: reason || undefined,
        },
        pageSignal,
      )
        .then(() => {
          setRequestingPermission(null);
          setReason("");
        })
        .finally(() => {
          setSubmitting(false);
        }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-sm font-medium text-foreground mb-3">
          Permissions
        </h2>

        <div className="zero-border rounded-lg overflow-hidden">
          {permissions.map((perm, idx) => {
            const isHighlighted = perm.name === highlightPermission;
            const currentPolicy =
              agent.firewallPolicies?.[ref]?.[perm.name] ??
              defaults?.[perm.name] ??
              "allow";
            const isPending = pendingPermissions.has(perm.name);

            return (
              <div key={perm.name}>
                {idx > 0 && <div className="border-t border-border/40" />}
                <div
                  className={`px-4 py-3 transition-colors ${
                    isHighlighted ? "bg-yellow-50 dark:bg-yellow-950/20" : ""
                  }`}
                >
                  <div className="flex items-center gap-2.5">
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
                    <PolicyPill policy={currentPolicy} disabled />
                    {isHighlighted && currentPolicy !== "allow" && (
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
                            onClick={() => setRequestingPermission(perm.name)}
                          >
                            Request Access
                          </Button>
                        )}
                      </>
                    )}
                  </div>

                  {requestingPermission === perm.name && (
                    <div className="mt-3 flex flex-col gap-2">
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
                            setRequestingPermission(null);
                            setReason("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSubmit(perm.name)}
                          disabled={submitting}
                        >
                          {submitting ? "Submitting..." : "Submit Request"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Show own pending requests */}
      {requests.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-foreground mb-3">
            <span className="flex items-center gap-1.5">
              <IconClock size={14} />
              Your Pending Requests ({requests.length})
            </span>
          </h2>

          <div className="zero-border rounded-lg overflow-hidden">
            {requests.map((req, idx) => (
              <div key={req.id}>
                {idx > 0 && <div className="border-t border-border/40" />}
                <div className="px-4 py-3">
                  <code className="text-xs font-medium text-foreground">
                    {req.permission}
                  </code>
                  {req.reason && (
                    <p className="text-xs text-muted-foreground mt-0.5 italic">
                      {req.reason}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Submitted {new Date(req.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
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

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <header className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-2">
          <ConnectorIcon type={ref} size={28} />
          <div>
            <h1 className="text-base font-semibold text-foreground flex items-center gap-2">
              <IconShieldLock size={18} />
              {connectorLabel} Firewall Permissions
            </h1>
            <p className="text-xs text-muted-foreground">
              for {agentDisplayName}
            </p>
          </div>
        </div>

        {/* Context banner for blocked requests */}
        {method && path && (
          <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-2.5">
            <p className="text-xs text-amber-800 dark:text-amber-200 flex items-center gap-1.5">
              <IconAlertTriangle size={14} />A request was blocked:{" "}
              <code className="font-mono font-medium">
                {method} {path}
              </code>
            </p>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto px-6 pb-6">
        {isAdmin ? (
          <AdminView
            agentId={agentId}
            ref={ref}
            highlightPermission={highlightPermission}
            agent={agent}
          />
        ) : (
          <MemberView
            agentId={agentId}
            ref={ref}
            highlightPermission={highlightPermission}
            method={method}
            path={path}
            agent={agent}
          />
        )}
      </main>
    </div>
  );
}
