// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCheck,
  IconBan,
  IconLink,
  IconAlertTriangle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import {
  isFirewallConnectorType,
  CONNECTOR_TYPES,
  resolveFirewallPolicies,
  type FirewallPolicies,
} from "@vm0/core";
import { user$ } from "../../signals/auth.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  permissionAllowAgentId$,
  permissionAllowRef$,
  permissionAllowPermission$,
  permissionAllowMethod$,
  permissionAllowPath$,
  permissionAllowAgent$,
  permissionAllowAction$,
  permissionAllowRequestId$,
  permissionRequestById$,
  permissionExistingRequest$,
  resendFormVisible$,
  showResendForm$,
  extractPermissions,
  saveAdminFocusedPolicy$,
  resolveAndUpdatePolicy$,
  linkCopied$,
  copyLink$,
  reason$,
  setReason$,
  submitAccessRequest$,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";
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
// Shared card components
// ---------------------------------------------------------------------------

function AgentPill({
  avatarUrl,
  displayName,
}: {
  avatarUrl: string | null;
  displayName: string;
}) {
  return (
    <div className="w-full rounded-lg border border-border bg-muted/30 pl-2 pr-8 py-3 flex items-center gap-2">
      <AvatarFromUrl
        avatarUrl={avatarUrl}
        alt=""
        className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
      />
      <span className="text-sm font-medium text-foreground">{displayName}</span>
    </div>
  );
}

function ConnectorPermissionCard({
  connectorRef,
  permission,
  action = "allow",
}: {
  connectorRef: string;
  permission: { name: string; description?: string };
  action?: "allow" | "deny";
}) {
  const connectorConfig =
    CONNECTOR_TYPES[connectorRef as keyof typeof CONNECTOR_TYPES];
  const connectorLabel = connectorConfig?.label ?? connectorRef;
  const connectorHelpText = connectorConfig?.helpText ?? "";

  return (
    <div className="w-full rounded-lg border border-border px-4 py-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 border-b border-border/70 pb-4 pt-1">
          {isFirewallConnectorType(connectorRef) && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
              <ConnectorIcon type={connectorRef} size={20} />
            </span>
          )}
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <p className="text-sm font-medium text-foreground">
              {connectorLabel}
            </p>
            {connectorHelpText && (
              <p className="text-xs text-muted-foreground line-clamp-1">
                {connectorHelpText}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 py-2">
          {action === "allow" ? (
            <IconCheck
              size={20}
              className="shrink-0 text-green-600 opacity-70"
            />
          ) : (
            <IconBan
              size={20}
              className="shrink-0 text-destructive opacity-70"
            />
          )}
          <span className="min-w-0 flex-1 text-sm text-foreground truncate">
            {permission.description ?? permission.name}
          </span>
          <code className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-sky-700">
            {permission.name}
          </code>
        </div>
      </div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <VM0Logo />
        <IconLoader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

function PermissionsUpdatedCard() {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <IconCheck size={40} className="text-green-600 opacity-70" />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            Permissions updated
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Agent permissions have been updated
          </p>
        </div>
      </div>
    </div>
  );
}

function PermissionsDeniedCard({ onResend }: { onResend?: () => void }) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <IconBan size={40} className="text-destructive opacity-70" />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            Permissions denied
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Agent permissions have been denied
          </p>
        </div>
        {onResend && (
          <button
            type="button"
            onClick={onResend}
            className="h-9 w-full rounded-[10px] bg-[#ED4E01] hover:bg-[#d44500] text-white font-medium text-sm transition-colors"
          >
            Resend request
          </button>
        )}
      </div>
    </div>
  );
}

function CopyLinkCard() {
  const pageSignal = useGet(pageSignal$);
  const copied = useGet(linkCopied$);
  const [, doCopyLink] = useLoadableSet(copyLink$);

  const handleCopyLink = () => {
    detach(doCopyLink(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <IconCheck size={40} className="text-green-600 opacity-70" />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            Permission change requested successfully
          </p>
          <p className="text-center text-sm text-muted-foreground">
            The agent owner has been notified. If they don&apos;t receive the
            notification, copy and share the link below.
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopyLink}
          className="inline-flex h-9 w-full items-center justify-center gap-2.5 rounded-[10px] border border-border bg-background text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
        >
          {copied ? (
            <>
              <IconCheck size={16} />
              Copied
            </>
          ) : (
            <>
              <IconLink size={16} />
              Copy link
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request mode (?request=<id>)
// ---------------------------------------------------------------------------

function AdminApprovalCard({
  userName,
  requesterName,
  requesterUserId,
  agentDisplayName,
  agentAvatarUrl,
  connectorRef,
  permission,
  action,
  reason,
  onApprove,
  onReject,
  resolving,
}: {
  userName: string;
  requesterName: string | null;
  requesterUserId: string;
  agentDisplayName: string;
  agentAvatarUrl: string | null;
  connectorRef: string;
  permission: { name: string; description?: string };
  action: "allow" | "deny";
  reason: string | null;
  onApprove: () => void;
  onReject: () => void;
  resolving: boolean;
}) {
  const displayRequester = requesterName ?? requesterUserId;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <VM0Logo />

        <div className="flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-4 px-[26px]">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {`Hey ${userName}, ${displayRequester} is requesting approval to update ${agentDisplayName}'s permissions.`}
          </p>

          <AgentPill
            avatarUrl={agentAvatarUrl}
            displayName={agentDisplayName}
          />

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">Would like to</p>
            <ConnectorPermissionCard
              connectorRef={connectorRef}
              permission={permission}
              action={action}
            />
          </div>

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">
              Reasons for request
            </p>
            <div className="text-sm w-full min-h-[100px] rounded-lg border border-border bg-muted/30 px-3 py-2 text-foreground whitespace-pre-wrap">
              {reason || ""}
            </div>
          </div>
        </div>

        <div className="flex w-[500px] max-w-[calc(100vw-96px)] gap-3 px-[26px]">
          <Button
            variant="outline"
            className="flex-1 rounded-lg"
            onClick={onReject}
            disabled={resolving}
          >
            <IconX size={16} />
            Deny change
          </Button>
          <Button
            variant="outline"
            className="flex-1 rounded-lg"
            onClick={onApprove}
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

function ResendFormCard({
  agentId,
  ref,
  permission,
  action,
  request,
  agentDisplayName,
  agentAvatarUrl,
  userName,
}: {
  agentId: string;
  ref: string;
  permission: { name: string; description?: string };
  action: "allow" | "deny";
  request: { method: string | null; path: string | null };
  agentDisplayName: string;
  agentAvatarUrl: string | null;
  userName: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const [submitLoadable, submitRequest] = useLoadableSet(submitAccessRequest$);
  const reason = useGet(reason$);
  const setReasonValue = useSet(setReason$);
  const submitting = submitLoadable.state === "loading";

  if (submitting || submitLoadable.state === "hasData") {
    return <LoadingCard />;
  }

  const handleSubmit = () => {
    detach(
      submitRequest(
        {
          agentId,
          connectorRef: ref,
          permission: permission.name,
          action,
          method: request.method ?? undefined,
          path: request.path ?? undefined,
          reason: reason || undefined,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <VM0Logo />

        <div className="flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-4 px-[26px]">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {`Hey ${userName}, you're requesting approval to update ${agentDisplayName}'s permissions.`}
          </p>

          <AgentPill
            avatarUrl={agentAvatarUrl}
            displayName={agentDisplayName}
          />

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">Would like to</p>
            <ConnectorPermissionCard
              connectorRef={ref}
              permission={permission}
              action={action}
            />
          </div>

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">
              Reasons for request
            </p>
            <textarea
              placeholder="I need this permission to run the task with this agent as part of a required compliance project."
              value={reason}
              onChange={(e) => {
                return setReasonValue(e.target.value);
              }}
              className="text-sm w-full h-[100px] rounded-lg border border-input bg-background px-3 py-2 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
            />
          </div>
        </div>

        <div className="w-[500px] max-w-[calc(100vw-96px)] px-[26px]">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="h-9 w-full rounded-[10px] bg-[#ED4E01] hover:bg-[#d44500] text-white font-medium text-sm transition-colors disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Request approval"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestStatusView({
  request,
  canManagePermissions,
  agent,
  userName,
  agentDisplayName,
}: {
  request: {
    id: string;
    agentId: string;
    connectorRef: string;
    permission: string;
    action: "allow" | "deny";
    method: string | null;
    path: string | null;
    reason: string | null;
    status: "pending" | "approved" | "rejected";
    requesterName: string | null;
    requesterUserId: string;
  };
  canManagePermissions: boolean;
  agent: { avatarUrl: string | null };
  userName: string;
  agentDisplayName: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const [resolveLoadable, resolveRequest] = useLoadableSet(
    resolveAndUpdatePolicy$,
  );
  const showResendFormValue = useGet(resendFormVisible$);
  const doShowResendForm = useSet(showResendForm$);

  const ref = request.connectorRef;
  const permission = findPermission(ref, request.permission) ?? {
    name: request.permission,
  };

  if (request.status === "approved") {
    return <PermissionsUpdatedCard />;
  }

  // Rejected — member: resend form or denied card
  if (request.status === "rejected" && !canManagePermissions) {
    if (showResendFormValue) {
      return (
        <ResendFormCard
          agentId={request.agentId}
          ref={ref}
          permission={permission}
          action={request.action}
          request={request}
          agentDisplayName={agentDisplayName}
          agentAvatarUrl={agent.avatarUrl}
          userName={userName}
        />
      );
    }
    return <PermissionsDeniedCard onResend={doShowResendForm} />;
  }

  if (request.status === "rejected") {
    return <PermissionsDeniedCard />;
  }

  if (canManagePermissions) {
    return (
      <AdminApprovalCard
        userName={userName}
        requesterName={request.requesterName}
        requesterUserId={request.requesterUserId}
        agentDisplayName={agentDisplayName}
        agentAvatarUrl={agent.avatarUrl}
        connectorRef={ref}
        permission={permission}
        action={request.action}
        reason={request.reason}
        onApprove={() => {
          detach(
            resolveRequest(request.id, "approve", request.action, pageSignal),
            Reason.DomCallback,
          );
        }}
        onReject={() => {
          detach(
            resolveRequest(request.id, "reject", request.action, pageSignal),
            Reason.DomCallback,
          );
        }}
        resolving={resolveLoadable.state === "loading"}
      />
    );
  }

  return <CopyLinkCard />;
}

function RequestModeView() {
  const agentId = useGet(permissionAllowAgentId$);
  const agentLoadable = useLastLoadable(permissionAllowAgent$);
  const userLoadable = useLastLoadable(user$);
  const adminLoadable = useLoadable(isOrgAdmin$);
  const requestLoadable = useLastLoadable(permissionRequestById$);

  if (
    agentLoadable.state === "loading" ||
    userLoadable.state === "loading" ||
    adminLoadable.state === "loading" ||
    requestLoadable.state === "loading"
  ) {
    return <LoadingCard />;
  }

  if (agentLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load agent" />;
  }

  const agent = agentLoadable.data;
  if (!agent) {
    return <ErrorMessage message="Agent not found" />;
  }

  const request =
    requestLoadable.state === "hasData" ? requestLoadable.data : null;
  if (!request) {
    return <ErrorMessage message="Access request not found" />;
  }

  const currentUser =
    userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;
  const canManagePermissions = currentUser?.id === agent.ownerId || isAdmin;

  return (
    <RequestStatusView
      request={request}
      canManagePermissions={canManagePermissions}
      agent={agent}
      userName={resolveUserName(currentUser)}
      agentDisplayName={agent.displayName ?? agentId ?? ""}
    />
  );
}

// ---------------------------------------------------------------------------
// Doctor mode (no ?request param)
// ---------------------------------------------------------------------------

function DoctorModeView({
  agentId,
  ref,
  permission,
  action,
  method,
  path,
  canManagePermissions,
  agent,
  userName,
}: {
  agentId: string;
  ref: string;
  permission: { name: string; description?: string };
  action: "allow" | "deny";
  method: string | null;
  path: string | null;
  canManagePermissions: boolean;
  agent: {
    permissionPolicies: FirewallPolicies | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
  userName: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, savePolicies] = useLoadableSet(saveAdminFocusedPolicy$);
  const [submitLoadable, submitRequest] = useLoadableSet(submitAccessRequest$);
  const reason = useGet(reason$);
  const setReasonValue = useSet(setReason$);

  const saving = saveLoadable.state === "loading";
  const submitting = submitLoadable.state === "loading";
  const agentDisplayName = agent.displayName ?? agentId;

  // Check effective policy
  const resolved = resolveFirewallPolicies(agent.permissionPolicies, [ref]);
  const effectivePolicy = resolved?.[ref]?.policies[permission.name] ?? "allow";

  // Policy already matches — show result
  if (effectivePolicy === action) {
    return action === "allow" ? (
      <PermissionsUpdatedCard />
    ) : (
      <PermissionsDeniedCard />
    );
  }

  // Policy doesn't match — admin: confirm card
  if (canManagePermissions) {
    const handleSave = () => {
      detach(
        savePolicies(
          {
            agentId,
            ref,
            permissionName: permission.name,
            action,
            agentFirewallPolicies: agent.permissionPolicies,
          },
          pageSignal,
        ),
        Reason.DomCallback,
      );
    };

    if (saveLoadable.state === "hasData") {
      return action === "allow" ? (
        <PermissionsUpdatedCard />
      ) : (
        <PermissionsDeniedCard />
      );
    }

    return (
      <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto flex flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
          <VM0Logo />

          <div className="flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-4 px-[26px]">
            <p className="text-center text-lg font-medium leading-7 text-foreground">
              {`Hey ${userName}, you are going to change ${agentDisplayName}'s permissions.`}
            </p>

            <AgentPill
              avatarUrl={agent.avatarUrl}
              displayName={agentDisplayName}
            />

            <div className="w-full flex flex-col gap-3">
              <p className="text-sm font-medium text-foreground">
                Would like to
              </p>
              <ConnectorPermissionCard
                connectorRef={ref}
                permission={permission}
                action={action}
              />
            </div>
          </div>

          <div className="w-[500px] max-w-[calc(100vw-96px)] px-[26px]">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="h-9 w-full rounded-[10px] bg-[#ED4E01] hover:bg-[#d44500] text-white font-medium text-sm transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Policy doesn't match — member: request form
  if (submitting || submitLoadable.state === "hasData") {
    return <LoadingCard />;
  }

  const handleSubmit = () => {
    detach(
      submitRequest(
        {
          agentId,
          connectorRef: ref,
          permission: permission.name,
          action,
          method: method ?? undefined,
          path: path ?? undefined,
          reason: reason || undefined,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <VM0Logo />

        <div className="flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-4 px-[26px]">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {`Hey ${userName}, you're requesting approval to update ${agentDisplayName}'s permissions.`}
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
              action={action}
            />
          </div>

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">
              Reasons for request
            </p>
            <textarea
              placeholder="I need this permission to run the task with this agent as part of a required compliance project."
              value={reason}
              onChange={(e) => {
                return setReasonValue(e.target.value);
              }}
              className="text-sm w-full h-[100px] rounded-lg border border-input bg-background px-3 py-2 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
            />
          </div>
        </div>

        <div className="w-[500px] max-w-[calc(100vw-96px)] px-[26px]">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="h-9 w-full rounded-[10px] bg-[#ED4E01] hover:bg-[#d44500] text-white font-medium text-sm transition-colors disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Request approval"}
          </button>
        </div>
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
// Main Page
// ---------------------------------------------------------------------------

export function PermissionAllowPage() {
  const agentId = useGet(permissionAllowAgentId$);
  const ref = useGet(permissionAllowRef$);
  const permission = useGet(permissionAllowPermission$);
  const method = useGet(permissionAllowMethod$);
  const path = useGet(permissionAllowPath$);
  const action = useGet(permissionAllowAction$);
  const requestId = useGet(permissionAllowRequestId$);

  const agentLoadable = useLastLoadable(permissionAllowAgent$);
  const userLoadable = useLastLoadable(user$);
  const adminLoadable = useLoadable(isOrgAdmin$);
  const existingRequestLoadable = useLoadable(permissionExistingRequest$);

  if (!agentId) {
    return <ErrorMessage message="Missing agent ID in URL parameters" />;
  }

  // Request mode: URL is ?request=<id>, self-contained view
  if (requestId) {
    return <RequestModeView />;
  }

  // Doctor mode: needs ref + permission
  if (!ref || !permission) {
    return <ErrorMessage message="Missing permission in URL parameters" />;
  }

  if (!isFirewallConnectorType(ref)) {
    return <ErrorMessage message={`Unknown permission: ${ref}`} />;
  }

  if (
    agentLoadable.state === "loading" ||
    userLoadable.state === "loading" ||
    adminLoadable.state === "loading"
  ) {
    return <LoadingCard />;
  }

  if (agentLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load agent" />;
  }

  const agent = agentLoadable.data;
  if (!agent) {
    return <ErrorMessage message="Agent not found" />;
  }

  const currentUser =
    userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;
  const canManagePermissions = currentUser?.id === agent.ownerId || isAdmin;
  const userName = resolveUserName(currentUser);
  const focusedPermission = findPermission(ref, permission);

  if (!focusedPermission) {
    return <ErrorMessage message={`Unknown permission: ${permission}`} />;
  }

  // Member doctor mode: wait for existing-request check so page-setup
  // can redirect to request mode before we render anything.
  if (!canManagePermissions && existingRequestLoadable.state === "loading") {
    return <LoadingCard />;
  }

  return (
    <DoctorModeView
      agentId={agentId}
      ref={ref}
      permission={focusedPermission}
      action={action ?? "allow"}
      method={method}
      path={path}
      canManagePermissions={canManagePermissions}
      agent={{
        permissionPolicies: agent.permissionPolicies,
        displayName: agent.displayName,
        avatarUrl: agent.avatarUrl,
      }}
      userName={userName}
    />
  );
}
