import { useState } from "react";
import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import { Button } from "@vm0/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCheck,
  IconBan,
  IconShieldLock,
  IconAlertTriangle,
  IconClock,
  IconX,
} from "@tabler/icons-react";
import {
  isFirewallConnectorType,
  CONNECTOR_TYPES,
  getDefaultFirewallPolicies,
  groupPermissionsByCategory,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/core";
import { user$ } from "../../signals/auth.ts";
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
import { resolveAvatarUrl } from "../zero-page/avatar-utils.ts";
import avatar1Img from "../zero-page/assets/avatar_1.webp";
import { detach, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// VM0 Logo
// ---------------------------------------------------------------------------

function VM0Logo() {
  return (
    <svg
      width="80"
      height="24"
      viewBox="0 0 100 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-foreground"
    >
      <path
        d="M13.3915 0.0627979C13.2455 -0.0209506 13.0657 -0.020839 12.9198 0.0630906L1.0053 6.91543C0.692394 7.09539 0.690093 7.54442 1.00114 7.72755L12.9156 14.7423C13.0636 14.8295 13.2475 14.8296 13.3957 14.7426L25.3445 7.72785C25.6562 7.54485 25.6539 7.09497 25.3404 6.91514L13.3915 0.0627979Z"
        fill="#ED4E01"
      />
      <path
        d="M0.710495 8.33374L12.6479 15.2595C12.7944 15.3445 12.8846 15.5015 12.8846 15.6715L12.8843 29.5237C12.8843 29.8899 12.4897 30.1187 12.1741 29.9356L0.236691 23.0096C0.0902206 22.9246 -3.46036e-06 22.7676 0 22.5977L0.00028208 8.74568C0.000289537 8.37949 0.394855 8.15064 0.710495 8.33374Z"
        fill="#ED4E01"
      />
      <path
        d="M24.947 21.6772C24.947 21.9507 24.8017 22.2036 24.5655 22.3415L16.2103 27.219C15.6975 27.5184 15.0533 27.1485 15.0533 26.5547L15.0531 16.7842C15.0531 16.5107 15.1983 16.2578 15.4345 16.1199L23.7897 11.2425C24.3025 10.9431 24.9468 11.313 24.9468 11.9068L24.947 21.6772ZM13.6541 16.3426V29.5279C13.6541 29.8852 14.0308 30.1106 14.3391 29.9444L14.3538 29.9362L25.5769 23.3654C26.25 22.9808 26.3462 22.6924 26.3459 22.1188L26.3459 8.93378C26.3459 8.57084 25.9572 8.344 25.6462 8.52548L14.4231 15.0001C14.0385 15.2885 13.6539 15.577 13.6541 16.3426Z"
        fill="#ED4E01"
      />
      <path
        d="M25.9616 10.58L15.2113 28.4616L14.2308 27.8817L24.981 10.0001L25.9616 10.58Z"
        fill="#ED4E01"
      />
      <path
        d="M42.1865 25L34.3459 5H37.4651L43.7887 21.4575L50.1264 5H53.2315L45.3908 25H42.1865Z"
        fill="currentColor"
      />
      <path
        d="M66.9877 25L59.4023 10.3417V25H56.4957V5H59.6716L67.413 20.0628L75.1686 5H78.3304V25H75.438V10.3417L67.8526 25H66.9877Z"
        fill="currentColor"
      />
      <path
        d="M99.3459 22.1409C99.3459 22.5314 99.2703 22.9033 99.1191 23.2566C98.9678 23.6007 98.7599 23.9028 98.4952 24.1632C98.2305 24.4235 97.9186 24.6281 97.5594 24.7768C97.2097 24.9256 96.8363 25 96.4393 25H86.2735C85.8765 25 85.4984 24.9256 85.1392 24.7768C84.7894 24.6281 84.4822 24.4235 84.2176 24.1632C83.9529 23.9028 83.745 23.6007 83.5937 23.2566C83.4425 22.9033 83.3669 22.5314 83.3669 22.1409V7.85914C83.3669 7.46862 83.4425 7.10135 83.5937 6.75732C83.745 6.404 83.9529 6.10181 84.2176 5.85077C84.4822 5.59042 84.7894 5.38587 85.1392 5.2371C85.4984 5.07903 85.8765 5 86.2735 5H96.4393C96.8363 5 97.2097 5.07903 97.5594 5.2371C97.9186 5.38587 98.2305 5.59042 98.4952 5.85077C98.7599 6.10181 98.9678 6.404 99.1191 6.75732C99.2703 7.10135 99.3459 7.46862 99.3459 7.85914V22.1409ZM86.2735 7.85914V22.1409H96.4393V7.85914H86.2735Z"
        fill="currentColor"
      />
      <path
        d="M94.8994 6.79107L97.1494 8.06891L87.8973 23.8325L85.6473 22.5547L94.8994 6.79107Z"
        fill="currentColor"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared card components for focused views
// ---------------------------------------------------------------------------

function AgentPill({
  avatarUrl,
  displayName,
}: {
  avatarUrl: string | null;
  displayName: string;
}) {
  const src = resolveAvatarUrl(avatarUrl) ?? avatar1Img;
  return (
    <div className="w-full rounded-lg bg-muted/50 px-4 py-3 flex items-center gap-3">
      <img
        src={src}
        alt=""
        className="h-8 w-8 shrink-0 rounded-full object-cover object-top"
      />
      <span className="text-sm font-medium text-foreground">{displayName}</span>
    </div>
  );
}

function ConnectorPermissionCard({
  connectorRef,
  permission,
}: {
  connectorRef: string;
  permission: { name: string; description?: string };
}) {
  const connectorConfig =
    CONNECTOR_TYPES[connectorRef as keyof typeof CONNECTOR_TYPES];
  const connectorLabel = connectorConfig?.label ?? connectorRef;
  const connectorHelpText = connectorConfig?.helpText ?? "";

  return (
    <div className="w-full rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        {isFirewallConnectorType(connectorRef) && (
          <ConnectorIcon type={connectorRef} size={28} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {connectorLabel}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {connectorHelpText}
          </p>
        </div>
      </div>
      <div className="border-t border-border px-4 py-2.5 flex items-center gap-2">
        <IconCheck size={16} className="text-green-600 shrink-0" />
        <span className="text-sm text-foreground flex-1">
          {permission.description ?? permission.name}
        </span>
        <code className="text-xs font-medium bg-muted px-2 py-0.5 rounded shrink-0">
          {permission.name}
        </code>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PolicyPill (used in list views and admin policy management)
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

// ---------------------------------------------------------------------------
// Focused single-permission admin view (owner/admin)
// ---------------------------------------------------------------------------

function AdminFocusedView({
  agentId,
  ref,
  permission,
  agent,
  userName,
}: {
  agentId: string;
  ref: string;
  permission: { name: string; description?: string };
  agent: {
    firewallPolicies: FirewallPolicies | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
  userName: string;
}) {
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;
  const pageSignal = useGet(pageSignal$);
  const requestsLoadable = useLastLoadable(firewallAccessRequests$);
  const setSavePolicies = useSet(saveFirewallPolicies$);
  const setResolveRequest = useSet(resolveAccessRequest$);

  const currentPolicy =
    agent.firewallPolicies?.[ref]?.[permission.name] ??
    defaults?.[permission.name] ??
    "allow";

  const [resolving, setResolving] = useState(false);
  const [policy, setPolicy] = useState<FirewallPolicyValue>(currentPolicy);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const requests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const pendingRequest = requests.find((r) => {
    return r.permission === permission.name;
  });
  const agentDisplayName = agent.displayName ?? agentId;
  const isDirty = policy !== currentPolicy;

  const handleApprove = () => {
    if (!pendingRequest) {
      return;
    }
    setResolving(true);
    const fullPolicies: FirewallPolicies = {
      ...agent.firewallPolicies,
      [ref]: {
        ...agent.firewallPolicies?.[ref],
        [permission.name]: "allow",
      },
    };
    detach(
      Promise.all([
        setResolveRequest(pendingRequest.id, "approve", pageSignal),
        setSavePolicies(agentId, fullPolicies, pageSignal),
      ]).finally(() => {
        setResolving(false);
      }),
      Reason.DomCallback,
    );
  };

  const handleReject = () => {
    if (!pendingRequest) {
      return;
    }
    setResolving(true);
    detach(
      setResolveRequest(pendingRequest.id, "reject", pageSignal).finally(() => {
        setResolving(false);
      }),
      Reason.DomCallback,
    );
  };

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
        .then(() => {
          setSaved(true);
        })
        .finally(() => {
          setSaving(false);
        }),
      Reason.DomCallback,
    );
  };

  // With pending request — approval card (Figma owner design)
  if (pendingRequest) {
    const requesterName =
      pendingRequest.requesterName ?? pendingRequest.requesterUserId;

    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[520px] rounded-2xl border border-border bg-background p-8 flex flex-col items-center gap-6">
          <VM0Logo />

          <p className="text-center text-base font-medium text-foreground">
            {"Hey "}
            {userName}
            {", "}
            {requesterName}
            {" is requesting approval to update "}
            {agentDisplayName}
            {"'s permissions."}
          </p>

          <AgentPill
            avatarUrl={agent.avatarUrl}
            displayName={agentDisplayName}
          />

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">Would like to</p>
            <ConnectorPermissionCard
              connectorRef={ref}
              permission={permission}
            />
          </div>

          <div className="w-full flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">
              Reasons for request
            </p>
            <textarea
              readOnly
              value={pendingRequest.reason ?? ""}
              rows={3}
              className="text-sm w-full rounded-lg border border-input bg-muted/30 px-3 py-2 text-foreground resize-y"
            />
          </div>

          <div className="w-full flex gap-3">
            <Button
              variant="outline"
              className="flex-1 rounded-full"
              onClick={handleReject}
              disabled={resolving}
            >
              <IconX size={16} />
              Disapprove change
            </Button>
            <Button
              variant="outline"
              className="flex-1 rounded-full"
              onClick={handleApprove}
              disabled={resolving}
            >
              <IconCheck size={16} />
              Approve change
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // No pending request — policy management card
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-[520px] rounded-2xl border border-border bg-background p-8 flex flex-col items-center gap-6">
        <VM0Logo />

        <p className="text-center text-base font-medium text-foreground">
          {"Manage "}
          {agentDisplayName}
          {"'s permissions"}
        </p>

        <AgentPill avatarUrl={agent.avatarUrl} displayName={agentDisplayName} />

        <div className="w-full flex flex-col gap-3">
          <ConnectorPermissionCard connectorRef={ref} permission={permission} />
        </div>

        <div className="w-full zero-border rounded-lg px-4 py-3 flex items-center gap-3">
          <PolicyPill policy={policy} onChange={setPolicy} />
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || (!isDirty && !saved)}
          >
            {saving ? "Saving..." : saved && !isDirty ? "Saved" : "Save"}
          </Button>
        </div>
      </div>
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
  userName,
}: {
  agentId: string;
  ref: string;
  permission: { name: string; description?: string };
  method: string | null;
  path: string | null;
  agent: {
    firewallPolicies: FirewallPolicies | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
  userName: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const requestsLoadable = useLastLoadable(firewallAccessRequests$);
  const setCreateRequest = useSet(createAccessRequest$);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const requests =
    requestsLoadable.state === "hasData" ? requestsLoadable.data : [];
  const isPending = requests.some((r) => {
    return r.permission === permission.name;
  });
  const agentDisplayName = agent.displayName ?? agentId;

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
          setReason("");
        })
        .finally(() => {
          setSubmitting(false);
        }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-[520px] rounded-2xl border border-border bg-background p-8 flex flex-col items-center gap-6">
        <VM0Logo />

        <p className="text-center text-base font-medium text-foreground">
          {"Hey "}
          {userName}
          {", you're requesting approval to update "}
          {agentDisplayName}
          {"'s permissions."}
        </p>

        <AgentPill avatarUrl={agent.avatarUrl} displayName={agentDisplayName} />

        <div className="w-full flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Would like to</p>
          <ConnectorPermissionCard connectorRef={ref} permission={permission} />
        </div>

        <div className="w-full flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">
            Reasons for request
          </p>
          <textarea
            placeholder="I need this permission to run the task with this agent as part of a required compliance project."
            value={reason}
            onChange={(e) => {
              return setReason(e.target.value);
            }}
            rows={3}
            className="text-sm w-full rounded-lg border border-input bg-background px-3 py-2 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
            disabled={isPending}
          />
        </div>

        {isPending ? (
          <div className="w-full text-center text-sm text-amber-600 dark:text-amber-400 flex items-center justify-center gap-1.5">
            <IconClock size={16} />
            Request pending approval
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full rounded-full bg-[#ED4E01] hover:bg-[#d44500] text-white font-medium py-2.5 px-4 text-sm transition-colors disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Request approval"}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List views (fallback when no specific permission in URL)
// ---------------------------------------------------------------------------

function PermissionRow({
  perm,
  policy,
  onChange,
  disabled,
  indented,
}: {
  perm: { name: string; description?: string };
  policy: FirewallPolicyValue;
  onChange?: (p: FirewallPolicyValue) => void;
  disabled?: boolean;
  indented?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2 ${disabled ? "" : "hover:bg-muted/50"} transition-colors ${indented ? "pl-6" : ""}`}
    >
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
      <PolicyPill policy={policy} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function CategoryHeader({
  category,
  count,
  onSetAll,
}: {
  category: string;
  count: number;
  onSetAll?: (p: FirewallPolicyValue) => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
      <span className="text-xs font-medium text-foreground">
        {category} ({count})
      </span>
      {onSetAll && (
        <span className="inline-flex shrink-0 rounded-md overflow-hidden text-xs font-medium zero-border">
          {POLICY_OPTIONS.map((opt, idx) => {
            return (
              <button
                key={opt.value}
                type="button"
                style={
                  idx > 0
                    ? { borderLeft: "0.7px solid hsl(var(--gray-400))" }
                    : undefined
                }
                onClick={() => {
                  return onSetAll(opt.value);
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/50"
              >
                {opt.value === "allow" && <IconCheck size={12} stroke={2.5} />}
                {opt.value === "deny" && <IconBan size={12} stroke={2.5} />}
                {opt.label}
              </button>
            );
          })}
        </span>
      )}
    </div>
  );
}

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
  const groups = groupPermissionsByCategory(permissions, ref);
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
      setSavePolicies(agentId, fullPolicies, pageSignal).finally(() => {
        setSaving(false);
      }),
      Reason.DomCallback,
    );
  };

  const handleSetGroupAll = (
    groupPerms: { name: string }[],
    policy: FirewallPolicyValue,
  ) => {
    setPolicies((prev) => {
      const next = { ...prev };
      for (const p of groupPerms) {
        next[p.name] = policy;
      }
      return next;
    });
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
        {groups
          ? groups.map((group, groupIdx) => {
              return (
                <div key={group.category}>
                  {groupIdx > 0 && (
                    <div className="border-t border-border/40" />
                  )}
                  <CategoryHeader
                    category={group.category}
                    count={group.permissions.length}
                    onSetAll={(p) => {
                      return handleSetGroupAll(group.permissions, p);
                    }}
                  />
                  {group.permissions.map((perm, idx) => {
                    return (
                      <div key={perm.name}>
                        {idx > 0 && (
                          <div className="border-t border-border/40" />
                        )}
                        <PermissionRow
                          perm={perm}
                          policy={policies[perm.name] ?? "allow"}
                          onChange={(p) => {
                            return setPolicies((prev) => {
                              return { ...prev, [perm.name]: p };
                            });
                          }}
                          indented
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })
          : permissions.map((perm, idx) => {
              return (
                <div key={perm.name}>
                  {idx > 0 && <div className="border-t border-border/40" />}
                  <PermissionRow
                    perm={perm}
                    policy={policies[perm.name] ?? "allow"}
                    onChange={(p) => {
                      return setPolicies((prev) => {
                        return { ...prev, [perm.name]: p };
                      });
                    }}
                  />
                </div>
              );
            })}
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
  const groups = groupPermissionsByCategory(permissions, ref);
  const defaults = isFirewallConnectorType(ref)
    ? getDefaultFirewallPolicies(ref)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-medium text-foreground">Permissions</h2>
      <div className="zero-border rounded-lg overflow-hidden">
        {groups
          ? groups.map((group, groupIdx) => {
              return (
                <div key={group.category}>
                  {groupIdx > 0 && (
                    <div className="border-t border-border/40" />
                  )}
                  <CategoryHeader
                    category={group.category}
                    count={group.permissions.length}
                  />
                  {group.permissions.map((perm, idx) => {
                    const currentPolicy =
                      agent.firewallPolicies?.[ref]?.[perm.name] ??
                      defaults?.[perm.name] ??
                      "allow";
                    return (
                      <div key={perm.name}>
                        {idx > 0 && (
                          <div className="border-t border-border/40" />
                        )}
                        <PermissionRow
                          perm={perm}
                          policy={currentPolicy}
                          disabled
                          indented
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })
          : permissions.map((perm, idx) => {
              const currentPolicy =
                agent.firewallPolicies?.[ref]?.[perm.name] ??
                defaults?.[perm.name] ??
                "allow";
              return (
                <div key={perm.name}>
                  {idx > 0 && <div className="border-t border-border/40" />}
                  <PermissionRow perm={perm} policy={currentPolicy} disabled />
                </div>
              );
            })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      {children}
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <StatusMessage>
      <div className="flex flex-col items-center gap-2">
        <IconAlertTriangle size={24} />
        <p className="text-sm">{message}</p>
      </div>
    </StatusMessage>
  );
}

function resolveUserName(
  user: { firstName?: string | null; username?: string | null } | undefined,
): string {
  if (user?.firstName) {
    return user.firstName;
  }
  if (user?.username) {
    return user.username;
  }
  return "there";
}

function findPermission(
  ref: string,
  name: string | null,
): { name: string; description?: string } | null {
  if (!name) {
    return null;
  }
  return (
    extractPermissions(ref).find((p) => {
      return p.name === name;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// List Layout
// ---------------------------------------------------------------------------

function FirewallAllowListLayout({
  agentId,
  ref,
  connectorLabel,
  agentDisplayName,
  canManageFirewall,
  agent,
}: {
  agentId: string;
  ref: string;
  connectorLabel: string;
  agentDisplayName: string;
  canManageFirewall: boolean;
  agent: {
    firewallPolicies: FirewallPolicies | null;
    displayName: string | null;
  };
}) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-2.5">
          {isFirewallConnectorType(ref) && (
            <ConnectorIcon type={ref} size={22} />
          )}
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
        {canManageFirewall ? (
          <AdminListView agentId={agentId} ref={ref} agent={agent} />
        ) : (
          <MemberListView ref={ref} agent={agent} />
        )}
      </main>
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
  const userLoadable = useLastLoadable(user$);
  const adminLoadable = useLoadable(isOrgAdmin$);

  if (!agentId || !ref) {
    return (
      <ErrorMessage message="Missing agent ID or firewall ref in URL parameters" />
    );
  }

  if (!isFirewallConnectorType(ref)) {
    return <ErrorMessage message={`Unknown firewall: ${ref}`} />;
  }

  if (agentLoadable.state === "loading" || userLoadable.state === "loading") {
    return (
      <StatusMessage>
        <p className="text-sm">Loading...</p>
      </StatusMessage>
    );
  }

  if (agentLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load agent" />;
  }

  const agent = agentLoadable.data;
  if (!agent) {
    return (
      <StatusMessage>
        <p className="text-sm">Agent not found</p>
      </StatusMessage>
    );
  }

  const currentUser =
    userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;
  const canManageFirewall = currentUser?.id === agent.ownerId || isAdmin;
  const connectorLabel = CONNECTOR_TYPES[ref].label;
  const agentDisplayName = agent.displayName ?? agentId;
  const userName = resolveUserName(currentUser);
  const focusedPermission = findPermission(ref, highlightPermission);

  if (focusedPermission) {
    return canManageFirewall ? (
      <AdminFocusedView
        agentId={agentId}
        ref={ref}
        permission={focusedPermission}
        agent={agent}
        userName={userName}
      />
    ) : (
      <MemberFocusedView
        agentId={agentId}
        ref={ref}
        permission={focusedPermission}
        method={method}
        path={path}
        agent={agent}
        userName={userName}
      />
    );
  }

  return (
    <FirewallAllowListLayout
      agentId={agentId}
      ref={ref}
      connectorLabel={connectorLabel}
      agentDisplayName={agentDisplayName}
      canManageFirewall={canManageFirewall}
      agent={agent}
    />
  );
}
