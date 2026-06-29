import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui";
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconLoader2,
} from "@tabler/icons-react";
import type {
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import {
  isFirewallMetadataConnectorType,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { user$ } from "../../signals/auth.ts";
import { firewallPermissionMetadataByConnector } from "../../signals/firewall-permission-metadata.ts";
import {
  findPermissionInMetadata,
  permissionAllowAction$,
  permissionAllowActionParam$,
  permissionAllowAgent$,
  permissionAllowAgentId$,
  permissionAllowExpiresIn$,
  permissionAllowPermission$,
  permissionAllowRef$,
  permissionAllowUserPermissionGrants$,
  resolveUserPermissionGrantPolicy,
  type Permission,
  applyUserPermissionGrant$,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN,
  permissionGrantExpiresInByScope$,
  permissionGrantExpiryText,
  setPermissionGrantExpiresIn$,
} from "../../signals/permission-allow/permission-grant-expiration.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";
import { PermissionGrantDurationSelect } from "../components/permission-grant-duration-select.tsx";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";

function TargetPill({
  avatarUrl,
  displayName,
}: {
  avatarUrl?: string | null;
  displayName: string;
}) {
  return (
    <div className="w-full rounded-lg border border-border bg-muted/30 pl-2 pr-8 py-3 flex items-center gap-2">
      <AvatarFromUrl
        avatarUrl={avatarUrl ?? null}
        alt=""
        className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
      />
      <span className="text-sm font-medium text-foreground">{displayName}</span>
    </div>
  );
}

type PermissionGrantTarget = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
};

type PermissionAllowAgent = {
  displayName?: string | null;
  avatarUrl?: string | null;
} | null;

function resolvePermissionGrantTarget({
  agentId,
  agent,
}: {
  agentId: string;
  agent: PermissionAllowAgent;
}): { target: PermissionGrantTarget } | { message: string } {
  if (!agent) {
    return { message: "Agent not found" };
  }
  return {
    target: {
      id: agentId,
      displayName: agent.displayName ?? agentId,
      avatarUrl: agent.avatarUrl ?? null,
    },
  };
}

function ConnectorPermissionCard({
  connectorRef,
  permission,
  action,
}: {
  connectorRef: string;
  permission: Permission;
  action: "allow" | "deny";
}) {
  const connectorConfig = isFirewallMetadataConnectorType(connectorRef)
    ? CONNECTOR_TYPES[connectorRef]
    : undefined;
  const connectorLabel = connectorConfig?.label ?? connectorRef;
  const connectorHelpText = connectorConfig?.helpText ?? "";

  return (
    <div className="w-full rounded-lg border border-border px-4 py-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 border-b border-border/70 pb-4 pt-1">
          {isFirewallMetadataConnectorType(connectorRef) && (
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

function ResultCard({
  action,
  alreadyApplied = false,
  expiresAt,
  showExpiry,
}: {
  action: "allow" | "deny";
  alreadyApplied?: boolean;
  expiresAt?: string | null;
  showExpiry: boolean;
}) {
  const allowed = action === "allow";
  const title = alreadyApplied
    ? allowed
      ? "Already allowed"
      : "Already denied"
    : allowed
      ? "Permissions updated"
      : "Permissions denied";
  const description = alreadyApplied
    ? allowed
      ? "Your connector permission grant is already allowed"
      : "Your connector permission grant is already denied"
    : allowed
      ? "Your connector permission grant has been updated"
      : "Your connector permission grant has been denied";
  const expiryText = showExpiry
    ? permissionGrantExpiryText(expiresAt ?? null)
    : null;
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          {allowed ? (
            <IconCheck size={40} className="text-green-600 opacity-70" />
          ) : (
            <IconBan size={40} className="text-destructive opacity-70" />
          )}
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {description}
          </p>
          {expiryText && (
            <p className="text-center text-xs font-medium text-amber-700 dark:text-amber-400">
              {expiryText}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusMessage({ children }: { children: ReactNode }) {
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

function anyLoadableIsLoading(
  loadables: readonly { state: string }[],
): boolean {
  return loadables.some((loadable) => {
    return loadable.state === "loading";
  });
}

function permissionAllowLoadErrorMessage({
  targetState,
  grantsState,
  metadataState,
}: {
  targetState: string;
  grantsState: string;
  metadataState: string;
}): string | null {
  if (targetState === "hasError") {
    return "Failed to load agent";
  }
  if (grantsState === "hasError") {
    return "Failed to load permission grants";
  }
  if (metadataState === "hasError") {
    return "Failed to load permission metadata";
  }
  return null;
}

function resolveExistingPermissionGrantResult({
  action,
  connectorRef,
  focusedPermission,
  grants,
  metadata,
}: {
  action: "allow" | "deny";
  connectorRef: string;
  focusedPermission: Permission;
  grants: readonly UserPermissionGrantResponse[];
  metadata: FirewallPermissionDetailMetadata;
}): { expiresAt?: string | null } | null {
  const effectivePolicy = resolveUserPermissionGrantPolicy(
    grants,
    metadata,
    focusedPermission.name,
  );
  const explicitGrant = grants.find((grant) => {
    return (
      grant.connectorRef === connectorRef &&
      grant.permission === focusedPermission.name &&
      grant.action === action
    );
  });

  if (effectivePolicy !== action) {
    return null;
  }
  return { expiresAt: explicitGrant?.expiresAt };
}

function ConfirmGrantCard({
  target,
  connectorRef,
  permission,
  action,
  initialExpiresIn,
  userName,
  grantLoadable,
  applyGrant,
}: {
  target: PermissionGrantTarget;
  connectorRef: string;
  permission: Permission;
  action: "allow" | "deny";
  initialExpiresIn: UserPermissionGrantExpiresIn | null;
  userName: string;
  grantLoadable: { state: string };
  applyGrant: (
    params: {
      agentId: string;
      connectorRef: string;
      permission: string;
      action: "allow" | "deny";
      expiresIn?: UserPermissionGrantExpiresIn;
    },
    signal: AbortSignal,
  ) => Promise<UserPermissionGrantResponse>;
}) {
  const pageSignal = useGet(pageSignal$);
  const durationScope = `agent\u0000${target.id}\u0000${connectorRef}\u0000${permission.name}\u0000${action}\u0000${initialExpiresIn ?? ""}`;
  const expiresInByScope = useGet(permissionGrantExpiresInByScope$);
  const setExpiresInForScope = useSet(setPermissionGrantExpiresIn$);
  const expiresIn =
    expiresInByScope[durationScope] ??
    initialExpiresIn ??
    DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN;
  const expirationAvailable = action === "allow";
  const saving = grantLoadable.state === "loading";

  const handleSave = () => {
    detach(
      applyGrant(
        {
          agentId: target.id,
          connectorRef,
          permission: permission.name,
          action,
          ...(expirationAvailable ? { expiresIn } : {}),
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
            {`Hey ${userName}, you're updating your permissions for ${target.displayName}.`}
          </p>

          <TargetPill
            avatarUrl={target.avatarUrl}
            displayName={target.displayName}
          />

          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">Would like to</p>
            <ConnectorPermissionCard
              connectorRef={connectorRef}
              permission={permission}
              action={action}
            />
          </div>
          {expirationAvailable && (
            <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
              <span className="text-sm font-medium text-foreground">
                Duration
              </span>
              <PermissionGrantDurationSelect
                value={expiresIn}
                onValueChange={(value) => {
                  setExpiresInForScope(durationScope, value);
                }}
                disabled={saving}
                ariaLabel="Permission duration"
              />
            </div>
          )}
        </div>

        <div className="w-[500px] max-w-[calc(100vw-96px)] px-[26px]">
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="h-9 w-full rounded-[10px]"
          >
            {saving ? "Saving..." : "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermissionAllowDoctorPage({
  agentId,
  ref,
  permission,
  action,
  initialExpiresIn,
}: {
  agentId: string;
  ref: string;
  permission: string;
  action: "allow" | "deny";
  initialExpiresIn: UserPermissionGrantExpiresIn | null;
}) {
  const agentLoadable = useLastLoadable(permissionAllowAgent$);
  const userLoadable = useLastLoadable(user$);
  const grantsLoadable = useLastLoadable(permissionAllowUserPermissionGrants$);
  const metadataLoadable = useLoadable(
    firewallPermissionMetadataByConnector({ connectorType: ref }),
  );
  const [grantLoadable, applyGrant] = useLoadableSet(applyUserPermissionGrant$);

  if (
    anyLoadableIsLoading([
      agentLoadable,
      userLoadable,
      grantsLoadable,
      metadataLoadable,
    ])
  ) {
    return <LoadingCard />;
  }

  const loadErrorMessage = permissionAllowLoadErrorMessage({
    targetState: agentLoadable.state,
    grantsState: grantsLoadable.state,
    metadataState: metadataLoadable.state,
  });
  if (loadErrorMessage) {
    return <ErrorMessage message={loadErrorMessage} />;
  }

  const agent = agentLoadable.state === "hasData" ? agentLoadable.data : null;
  const targetResult = resolvePermissionGrantTarget({
    agentId,
    agent,
  });
  if ("message" in targetResult) {
    return <ErrorMessage message={targetResult.message} />;
  }

  const metadata =
    metadataLoadable.state === "hasData" ? metadataLoadable.data : null;
  if (!metadata) {
    return <ErrorMessage message={`Unknown connector: ${ref}`} />;
  }

  const focusedPermission = findPermissionInMetadata(metadata, permission);
  if (!focusedPermission) {
    return <ErrorMessage message={`Unknown permission: ${permission}`} />;
  }

  const grants = grantsLoadable.state === "hasData" ? grantsLoadable.data : [];
  if (grantLoadable.state === "hasData") {
    return (
      <ResultCard
        action={action}
        expiresAt={grantLoadable.data.expiresAt}
        showExpiry={action === "allow"}
      />
    );
  }

  const existingGrantResult = resolveExistingPermissionGrantResult({
    action,
    connectorRef: ref,
    focusedPermission,
    grants,
    metadata,
  });
  if (existingGrantResult) {
    return (
      <ResultCard
        action={action}
        alreadyApplied
        expiresAt={existingGrantResult.expiresAt}
        showExpiry={action === "allow"}
      />
    );
  }

  const currentUser =
    userLoadable.state === "hasData" ? userLoadable.data : undefined;
  return (
    <ConfirmGrantCard
      target={targetResult.target}
      connectorRef={ref}
      permission={focusedPermission}
      action={action}
      initialExpiresIn={initialExpiresIn}
      userName={resolveUserName(currentUser)}
      grantLoadable={grantLoadable}
      applyGrant={applyGrant}
    />
  );
}

export function PermissionAllowPage() {
  const agentId = useGet(permissionAllowAgentId$);
  const ref = useGet(permissionAllowRef$);
  const permission = useGet(permissionAllowPermission$);
  const actionParam = useGet(permissionAllowActionParam$);
  const action = useGet(permissionAllowAction$);
  const expiresIn = useGet(permissionAllowExpiresIn$);

  if (!agentId) {
    return <ErrorMessage message="Missing agent ID in URL parameters" />;
  }

  if (!ref || !permission) {
    return <ErrorMessage message="Missing permission in URL parameters" />;
  }

  if (!isFirewallMetadataConnectorType(ref)) {
    return <ErrorMessage message={`Unknown connector: ${ref}`} />;
  }

  if (actionParam !== null && action === null) {
    return (
      <ErrorMessage message={`Unknown permission action: ${actionParam}`} />
    );
  }

  return (
    <PermissionAllowDoctorPage
      agentId={agentId}
      ref={ref}
      permission={permission}
      action={action ?? "allow"}
      initialExpiresIn={expiresIn}
    />
  );
}
