import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui";
import {
  IconAlertTriangle,
  IconBan,
  IconChevronRight,
  IconCheck,
  IconLoader2,
} from "@tabler/icons-react";
import type {
  UnattendedTriggerPermissionAction,
  UnattendedTriggerPermissionPolicy,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  isFirewallMetadataConnectorType,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { firewallPermissionMetadataByConnector } from "../../signals/firewall-permission-metadata.ts";
import {
  currentTriggerPermissionEditorSignals$,
  mergeConnectorPolicy,
  resolveTriggerPermissionAction,
  setTriggerPermissionsConnectorSearch$,
  triggerPermissionsAgentId$,
  triggerPermissionsConnectorSearch$,
  triggerPermissionsRef$,
  triggerPermissionsTrigger$,
  triggerPermissionsTriggerId$,
  triggerPermissionsWorkflowId$,
  type TriggerPermissionEditorSignals,
} from "../../signals/trigger-permissions/trigger-permissions-signals.ts";
import { setWorkflowTriggerPermissionPolicy$ } from "../../signals/workflows-page/workflows-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";
import { Link } from "../router/link.tsx";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";

const TRIGGER_PERMISSION_CONNECTORS = [...CONNECTOR_TYPE_KEYS]
  .filter((type) => {
    return isFirewallMetadataConnectorType(type);
  })
  .sort((left, right) => {
    return CONNECTOR_TYPES[left].label.localeCompare(
      CONNECTOR_TYPES[right].label,
    );
  });
const COMMON_TRIGGER_PERMISSION_CONNECTORS: readonly ConnectorType[] = [
  "gmail",
  "google-drive",
  "github",
  "slack",
  "notion",
  "google-calendar",
  "google-sheets",
  "google-docs",
  "google-cloud",
  "cloudflare",
  "stripe",
  "maskdb",
] as const;
const TRIGGER_PERMISSION_CONNECTOR_LIMIT = 24;

function visibleTriggerPermissionConnectors(query: string): readonly string[] {
  const normalizedQuery = query.trim().toLowerCase();
  const matches = normalizedQuery
    ? TRIGGER_PERMISSION_CONNECTORS.filter((type) => {
        const config = CONNECTOR_TYPES[type as ConnectorType];
        const haystack = [type, config.label, config.helpText ?? ""]
          .join("\n")
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : TRIGGER_PERMISSION_CONNECTORS.filter((type) => {
        return COMMON_TRIGGER_PERMISSION_CONNECTORS.includes(
          type as ConnectorType,
        );
      });
  return matches.slice(0, TRIGGER_PERMISSION_CONNECTOR_LIMIT);
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

function ConnectorPicker({
  agentId,
  workflowId,
  triggerId,
}: {
  readonly agentId: string;
  readonly workflowId: string;
  readonly triggerId: string;
}) {
  const query = useGet(triggerPermissionsConnectorSearch$);
  const setQuery = useSet(setTriggerPermissionsConnectorSearch$);
  const visibleConnectors = visibleTriggerPermissionConnectors(query);

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-10">
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium text-foreground">
          Trigger permissions
        </p>
        <p className="text-xs text-muted-foreground">
          Choose the connector this trigger may use when it fires unattended.
        </p>
      </div>
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        placeholder="Search connectors"
        className="h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none focus:border-primary"
      />
      <div className="flex flex-col divide-y divide-border/70 rounded-lg border border-border">
        {visibleConnectors.map((type) => {
          const config = CONNECTOR_TYPES[type as ConnectorType];
          return (
            <Link
              key={type}
              pathname={ROUTES.agentWorkflowTriggerPermissions}
              options={{
                pathParams: { agentId, workflowId, triggerId },
                searchParams: new URLSearchParams({ ref: type }),
              }}
              className="flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
                <ConnectorIcon type={type as ConnectorType} size={20} />
              </span>
              <span className="min-w-0 flex-1 flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">
                  {config.label}
                </span>
                {config.helpText && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {config.helpText}
                  </span>
                )}
              </span>
              <IconChevronRight
                size={16}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
            </Link>
          );
        })}
        {visibleConnectors.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No connectors found
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PermissionToggle({
  action,
  disabled,
  onChange,
}: {
  action: UnattendedTriggerPermissionAction;
  disabled: boolean;
  onChange: (action: UnattendedTriggerPermissionAction) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={action === "allow"}
        onClick={() => {
          onChange("allow");
        }}
        className={`flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
          action === "allow"
            ? "bg-background text-green-700 shadow-sm dark:text-green-400"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <IconCheck size={14} />
        Allow
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={action === "deny"}
        onClick={() => {
          onChange("deny");
        }}
        className={`flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
          action === "deny"
            ? "bg-background text-destructive shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <IconBan size={14} />
        Deny
      </button>
    </div>
  );
}

function ConnectorPermissionEditorCard({
  triggerId,
  connectorRef,
  metadata,
  savedPolicy,
  editor,
}: {
  triggerId: string;
  connectorRef: string;
  metadata: FirewallPermissionDetailMetadata;
  savedPolicy: UnattendedTriggerPermissionPolicy | null;
  editor: TriggerPermissionEditorSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const overrides = useGet(editor.overrides$);
  const setOverride = useSet(editor.setOverride$);
  const [saveLoadable, save] = useLoadableSet(
    setWorkflowTriggerPermissionPolicy$,
  );
  const saving = saveLoadable.state === "loading";
  const saved = saveLoadable.state === "hasData";

  const connectorConfig = isFirewallMetadataConnectorType(connectorRef)
    ? CONNECTOR_TYPES[connectorRef]
    : undefined;
  const connectorLabel = connectorConfig?.label ?? metadata.label;
  const connectorHelpText = connectorConfig?.helpText ?? "";

  const actionFor = (permission: string): UnattendedTriggerPermissionAction => {
    return (
      overrides[permission] ??
      resolveTriggerPermissionAction(savedPolicy, connectorRef, permission)
    );
  };

  const dirty = metadata.permissions.some((permission) => {
    const override = overrides[permission.name];
    if (override === undefined) {
      return false;
    }
    return (
      override !==
      resolveTriggerPermissionAction(savedPolicy, connectorRef, permission.name)
    );
  });

  const handleSave = () => {
    const policies: Record<string, UnattendedTriggerPermissionAction> = {};
    for (const permission of metadata.permissions) {
      policies[permission.name] = actionFor(permission.name);
    }
    const merged = mergeConnectorPolicy(savedPolicy, connectorRef, policies);
    // After the save, `reloadWorkflows$` refetches the trigger; once its policy
    // reflects the merge, the local overrides match the saved state and `dirty`
    // collapses to false on its own — no explicit reset needed.
    detach(
      save({ triggerId, unattendedPermissionPolicy: merged }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-10">
      <div className="flex items-center gap-3">
        {isFirewallMetadataConnectorType(connectorRef) && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
            <ConnectorIcon type={connectorRef} size={20} />
          </span>
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <p className="text-base font-medium text-foreground">
            {connectorLabel}
          </p>
          <p className="text-xs text-muted-foreground">
            Choose which {connectorLabel} permissions this trigger may use when
            it fires unattended.
          </p>
        </div>
      </div>

      {connectorHelpText && (
        <p className="text-xs text-muted-foreground">{connectorHelpText}</p>
      )}

      <div className="flex flex-col divide-y divide-border/70 rounded-lg border border-border">
        {metadata.permissions.map((permission) => {
          return (
            <div
              key={permission.name}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="min-w-0 flex-1 text-sm text-foreground">
                {permission.description ?? permission.name}
              </span>
              <code className="hidden shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-sky-700 sm:inline">
                {permission.name}
              </code>
              <PermissionToggle
                action={actionFor(permission.name)}
                disabled={saving}
                onChange={(action) => {
                  setOverride(permission.name, action);
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-3">
        {saved && !dirty && (
          <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-400">
            <IconCheck size={16} />
            Saved
          </span>
        )}
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="h-9 rounded-[10px]"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function TriggerPermissionsEditor({
  triggerId,
  connectorRef,
  editor,
}: {
  triggerId: string;
  connectorRef: string;
  editor: TriggerPermissionEditorSignals;
}) {
  const triggerLoadable = useLastLoadable(triggerPermissionsTrigger$);
  const metadataLoadable = useLoadable(
    firewallPermissionMetadataByConnector({ connectorType: connectorRef }),
  );

  if (
    triggerLoadable.state === "loading" ||
    metadataLoadable.state === "loading"
  ) {
    return <LoadingCard />;
  }

  if (triggerLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load trigger" />;
  }
  if (metadataLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load permission metadata" />;
  }

  const trigger = triggerLoadable.data;
  if (!trigger) {
    return <ErrorMessage message="Trigger not found" />;
  }

  const metadata = metadataLoadable.data;
  if (!metadata) {
    return <ErrorMessage message={`Unknown connector: ${connectorRef}`} />;
  }

  return (
    <ConnectorPermissionEditorCard
      triggerId={triggerId}
      connectorRef={connectorRef}
      metadata={metadata}
      savedPolicy={trigger.unattendedPermissionPolicy}
      editor={editor}
    />
  );
}

export function TriggerPermissionsPage() {
  const agentId = useGet(triggerPermissionsAgentId$);
  const workflowId = useGet(triggerPermissionsWorkflowId$);
  const triggerId = useGet(triggerPermissionsTriggerId$);
  const ref = useGet(triggerPermissionsRef$);
  const editor = useGet(currentTriggerPermissionEditorSignals$);

  if (!agentId) {
    return <ErrorMessage message="Missing agent ID in URL parameters" />;
  }

  if (!workflowId) {
    return <ErrorMessage message="Missing workflow ID in URL parameters" />;
  }

  if (!triggerId) {
    return <ErrorMessage message="Missing trigger ID in URL parameters" />;
  }

  if (!ref) {
    return (
      <ConnectorPicker
        agentId={agentId}
        workflowId={workflowId}
        triggerId={triggerId}
      />
    );
  }

  if (!isFirewallMetadataConnectorType(ref)) {
    return <ErrorMessage message={`Unknown connector: ${ref}`} />;
  }

  if (!editor) {
    return <LoadingCard />;
  }

  return (
    <TriggerPermissionsEditor
      triggerId={triggerId}
      connectorRef={ref}
      editor={editor}
    />
  );
}
