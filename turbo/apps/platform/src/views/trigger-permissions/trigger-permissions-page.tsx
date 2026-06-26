import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@vm0/ui";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronRight,
  IconCheck,
  IconAdjustmentsHorizontal,
  IconLoader2,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import type {
  UnattendedTriggerConnectorRefs,
  UnattendedTriggerPermissionAction,
  UnattendedTriggerPermissionPolicy,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  groupFirewallMetadataPermissionsByCategory,
  isFirewallMetadataConnectorType,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { firewallPermissionMetadataByConnector } from "../../signals/firewall-permission-metadata.ts";
import {
  allConnectorTypes$,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  currentTriggerPermissionEditorSignals$,
  mergeConnectorPolicy,
  resolveTriggerPermissionAction,
  setTriggerPermissionsDialogConnectorRef$,
  setTriggerPermissionEditorScrolled$,
  setTriggerPermissionEditorSearch$,
  setTriggerPermissionsDrawerConnector$,
  setTriggerPermissionsConnectorSearch$,
  toggleTriggerPermissionEditorGroup$,
  triggerPermissionEditorUiState$,
  triggerPermissionEditorUiStateForKey,
  triggerPermissionsAgentId$,
  triggerPermissionsConnectorSearch$,
  triggerPermissionsDialogConnectorRef$,
  triggerPermissionsDrawerConnector$,
  triggerPermissionsDrawerConnectorForTrigger,
  triggerPermissionsRef$,
  triggerPermissionsTrigger$,
  triggerPermissionsTriggerId$,
  triggerPermissionsWorkflowId$,
  triggerPermissionEditorSignalsForKey,
  type TriggerPermissionEditorSignals,
} from "../../signals/trigger-permissions/trigger-permissions-signals.ts";
import { setWorkflowTriggerPermissionPolicy$ } from "../../signals/workflows-page/workflows-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0Logo } from "../components/vm0-logo.tsx";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { Link } from "../router/link.tsx";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import {
  PermissionPolicyMixedBadge,
  PermissionPolicyToggle,
} from "../zero-page/components/settings/permission-policy-toggle.tsx";

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
type TriggerPermissionsLayout = "page" | "drawer" | "dialog";
interface ConnectorPermission {
  readonly name: string;
  readonly description?: string;
}

type TriggerPermissionPolicyState = UnattendedTriggerPermissionAction | "mixed";

interface TriggerPermissionGroup {
  readonly category: string;
  readonly permissions: ConnectorPermission[];
}

function defaultConnectorRefForTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): ConnectorType | null {
  if (trigger.kind !== "event") {
    return null;
  }
  const provider = trigger.eventConfig.provider;
  return isFirewallMetadataConnectorType(provider) ? provider : null;
}

function triggerContextText(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return trigger.scheduleSummary ?? "Schedule trigger";
  }
  if (trigger.eventType === "gmail-new-message") {
    return "Gmail new message";
  }
  if (trigger.eventType === "gmail-label-applied") {
    return `Gmail label applied: ${trigger.eventConfig.labelName}`;
  }
  if (trigger.eventType === "webhook-received") {
    return "Webhook";
  }
  return "Event trigger";
}

function sortPermissions(
  perms: readonly ConnectorPermission[],
): ConnectorPermission[] {
  return [...perms].sort((left, right) => {
    return left.name.localeCompare(right.name);
  });
}

function sortedPermissionsForMetadata(
  metadata: FirewallPermissionDetailMetadata,
): ConnectorPermission[] {
  return sortPermissions(metadata.permissions);
}

function buildSortedGroups(
  metadata: FirewallPermissionDetailMetadata,
): TriggerPermissionGroup[] | null {
  return (
    groupFirewallMetadataPermissionsByCategory(
      metadata.permissions,
      metadata,
    )?.map((group) => {
      return { ...group, permissions: sortPermissions(group.permissions) };
    }) ?? null
  );
}

function filterPermissionsForSearch(
  permissions: ConnectorPermission[],
  normalizedSearch: string,
): ConnectorPermission[] {
  if (normalizedSearch.length === 0) {
    return permissions;
  }
  return permissions.filter((permission) => {
    return (
      permission.name.toLowerCase().includes(normalizedSearch) ||
      (permission.description?.toLowerCase().includes(normalizedSearch) ??
        false)
    );
  });
}

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

function allowedPermissionNamesForConnector(
  trigger: ZeroWorkflowTriggerSummary,
  connectorRef: ConnectorType,
): readonly string[] {
  const policies =
    trigger.unattendedPermissionPolicy?.[connectorRef]?.policies ?? {};
  return Object.entries(policies)
    .filter(([, action]) => {
      return action === "allow";
    })
    .map(([permission]) => {
      return permission;
    })
    .sort((left, right) => {
      return left.localeCompare(right);
    });
}

function toggleConnectorRef(
  connectorRefs: readonly string[],
  connectorRef: string,
  enabled: boolean,
): UnattendedTriggerConnectorRefs {
  if (enabled) {
    return connectorRefs.includes(connectorRef)
      ? [...connectorRefs]
      : [...connectorRefs, connectorRef];
  }
  return connectorRefs.filter((ref) => {
    return ref !== connectorRef;
  });
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

function LoadingState({
  layout,
}: {
  readonly layout: TriggerPermissionsLayout;
}) {
  if (layout !== "page") {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <IconLoader2 size={16} className="mr-2 animate-spin" />
        Loading permissions...
      </div>
    );
  }
  return <LoadingCard />;
}

function ConnectorAllowedPermissions({
  allowedPermissions,
}: {
  readonly allowedPermissions: readonly string[];
}) {
  if (allowedPermissions.length === 0) {
    return null;
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {allowedPermissions.slice(0, 3).map((permission) => {
        return (
          <code
            key={permission}
            className="max-w-[160px] truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={permission}
          >
            {permission}
          </code>
        );
      })}
      {allowedPermissions.length > 3 ? (
        <span className="text-[11px] text-muted-foreground">
          +{allowedPermissions.length - 3} permissions
        </span>
      ) : null}
    </span>
  );
}

function ConnectorPickerRowContent({ type }: { readonly type: ConnectorType }) {
  const config = CONNECTOR_TYPES[type];

  return (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
        <ConnectorIcon type={type} size={19} />
      </span>
      <span className="min-w-0 flex flex-1 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">
          {config.label}
        </span>
        {config.helpText ? (
          <span className="line-clamp-1 text-xs text-muted-foreground">
            {config.helpText}
          </span>
        ) : null}
      </span>
    </>
  );
}

function ConnectorPickerRowToggle({
  connectorEnabled,
  saving,
  type,
  onToggleConnector,
}: {
  readonly connectorEnabled: boolean;
  readonly saving: boolean;
  readonly type: ConnectorType;
  readonly onToggleConnector: (
    connectorRef: ConnectorType,
    enabled: boolean,
  ) => void;
}) {
  const config = CONNECTOR_TYPES[type];

  return (
    <LoadingSwitch
      checked={connectorEnabled}
      loading={saving}
      ariaLabel={`${connectorEnabled ? "Disable" : "Enable"} ${config.label}`}
      onCheckedChange={(enabled) => {
        onToggleConnector(type, enabled);
      }}
    />
  );
}

function ConnectorPickerRow({
  agentId,
  workflowId,
  triggerId,
  type,
  connectorEnabled,
  allowedPermissions,
  saving,
  onSelectConnector,
  onConfigureConnector,
  onToggleConnector,
}: {
  readonly agentId: string;
  readonly workflowId: string;
  readonly triggerId: string;
  readonly type: ConnectorType;
  readonly connectorEnabled: boolean;
  readonly allowedPermissions?: readonly string[];
  readonly saving: boolean;
  readonly onSelectConnector?: (connectorRef: ConnectorType) => void;
  readonly onConfigureConnector?: (connectorRef: ConnectorType) => void;
  readonly onToggleConnector: (
    connectorRef: ConnectorType,
    enabled: boolean,
  ) => void;
}) {
  const config = CONNECTOR_TYPES[type];
  const canConfigurePermissions = isFirewallMetadataConnectorType(type);
  const showPermissionRow = connectorEnabled && canConfigurePermissions;
  const rowClass =
    "flex items-center gap-3 border-b border-border/50 px-3 py-3 transition-colors last:border-b-0 hover:bg-muted/40";
  const content = <ConnectorPickerRowContent type={type} />;
  const toggle = (
    <ConnectorPickerRowToggle
      connectorEnabled={connectorEnabled}
      saving={saving}
      type={type}
      onToggleConnector={onToggleConnector}
    />
  );

  if (onSelectConnector) {
    return (
      <div className={rowClass}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => {
            onSelectConnector(type);
          }}
        >
          {content}
        </button>
        {toggle}
        <IconChevronRight
          size={16}
          stroke={1.5}
          className="shrink-0 text-muted-foreground"
        />
      </div>
    );
  }

  if (onConfigureConnector) {
    return (
      <div className="flex flex-col gap-3 border-b border-border/50 px-3 py-3 last:border-b-0">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 text-left">
            {content}
          </div>
          <p className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {connectorEnabled ? "Authorized" : "Not authorized"}
          </p>
          {toggle}
        </div>
        {showPermissionRow ? (
          <div className="ml-12 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <ConnectorAllowedPermissions
                allowedPermissions={allowedPermissions ?? []}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              aria-label={`Edit ${config.label} permissions`}
              onClick={() => {
                onConfigureConnector(type);
              }}
            >
              <IconAdjustmentsHorizontal size={14} stroke={1.5} />
              Permissions
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={rowClass}>
      <Link
        pathname={ROUTES.agentWorkflowTriggerPermissions}
        options={{
          pathParams: { agentId, workflowId, triggerId },
          searchParams: new URLSearchParams({ ref: type }),
        }}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {content}
      </Link>
      {toggle}
      <IconChevronRight
        size={16}
        stroke={1.5}
        className="shrink-0 text-muted-foreground"
      />
    </div>
  );
}

function visibleConnectedTriggerPermissionConnectors(
  connectors: readonly ConnectorTypeWithStatus[],
  normalizedQuery: string,
): readonly ConnectorType[] {
  return connectors
    .filter((connector) => {
      if (!connector.connected) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return [
        connector.type,
        connector.label,
        connector.helpText,
        ...connector.tags,
      ]
        .join("\n")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .map((connector) => {
      return connector.type;
    });
}

function ConnectorPickerIntro({
  layout,
}: {
  readonly layout: TriggerPermissionsLayout;
}) {
  if (layout !== "page") {
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-base font-medium text-foreground">
        Trigger permissions
      </p>
      <p className="text-xs text-muted-foreground">
        Choose the connector this trigger may use when it runs unattended.
      </p>
    </div>
  );
}

function ConnectorPickerList({
  agentId,
  connectorRefs,
  connectorsLoading,
  layout,
  onConfigureConnector,
  onSelectConnector,
  onToggleConnector,
  saving,
  trigger,
  triggerId,
  visibleConnectors,
  workflowId,
}: {
  readonly agentId: string;
  readonly connectorRefs: readonly string[];
  readonly connectorsLoading: boolean;
  readonly layout: TriggerPermissionsLayout;
  readonly onConfigureConnector?: (connectorRef: ConnectorType) => void;
  readonly onSelectConnector?: (connectorRef: ConnectorType) => void;
  readonly onToggleConnector: (
    connectorRef: ConnectorType,
    enabled: boolean,
  ) => void;
  readonly saving: boolean;
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly triggerId: string;
  readonly visibleConnectors: readonly string[];
  readonly workflowId: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/70">
      {connectorsLoading ? (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <IconLoader2 size={14} className="animate-spin" />
          Loading connectors...
        </div>
      ) : null}
      {visibleConnectors.map((type) => {
        const connectorType = type as ConnectorType;
        return (
          <ConnectorPickerRow
            key={type}
            agentId={agentId}
            workflowId={workflowId}
            triggerId={triggerId}
            type={connectorType}
            connectorEnabled={connectorRefs.includes(type)}
            allowedPermissions={
              layout === "dialog"
                ? allowedPermissionNamesForConnector(trigger, connectorType)
                : undefined
            }
            saving={saving}
            onSelectConnector={onSelectConnector}
            onConfigureConnector={onConfigureConnector}
            onToggleConnector={onToggleConnector}
          />
        );
      })}
      {visibleConnectors.length === 0 && !connectorsLoading ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {layout === "dialog"
            ? "No connected connectors found"
            : "No connectors found"}
        </p>
      ) : null}
    </div>
  );
}

function ConnectorPicker({
  agentId,
  workflowId,
  triggerId,
  trigger: providedTrigger,
  layout = "page",
  onSelectConnector,
  onConfigureConnector,
  onPolicyChanged,
}: {
  readonly agentId: string;
  readonly workflowId: string;
  readonly triggerId: string;
  readonly trigger?: ZeroWorkflowTriggerSummary;
  readonly layout?: TriggerPermissionsLayout;
  readonly onSelectConnector?: (connectorRef: ConnectorType) => void;
  readonly onConfigureConnector?: (connectorRef: ConnectorType) => void;
  readonly onPolicyChanged?: () => void;
}) {
  const query = useGet(triggerPermissionsConnectorSearch$);
  const setQuery = useSet(setTriggerPermissionsConnectorSearch$);
  const pageSignal = useGet(pageSignal$);
  const triggerLoadable = useLastLoadable(triggerPermissionsTrigger$);
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const [saveLoadable, save] = useLoadableSet(
    setWorkflowTriggerPermissionPolicy$,
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleConnectors =
    layout === "dialog" && connectorTypesLoadable.state === "hasData"
      ? visibleConnectedTriggerPermissionConnectors(
          connectorTypesLoadable.data,
          normalizedQuery,
        )
      : visibleTriggerPermissionConnectors(query);
  const containerClass =
    layout === "page"
      ? "mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-10"
      : "flex min-h-0 flex-1 flex-col gap-4";

  if (!providedTrigger && triggerLoadable.state === "loading") {
    return <LoadingCard />;
  }
  if (!providedTrigger && triggerLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load trigger" />;
  }

  const trigger =
    providedTrigger ??
    (triggerLoadable.state === "hasData" ? triggerLoadable.data : null);
  if (!trigger) {
    return <ErrorMessage message="Trigger not found" />;
  }

  const connectorRefs = trigger.unattendedConnectorRefs;
  const saving = saveLoadable.state === "loading";
  const handleToggleConnector = (
    connectorRef: ConnectorType,
    enabled: boolean,
  ) => {
    detach(
      (async () => {
        await save(
          {
            triggerId,
            unattendedConnectorRefs: toggleConnectorRef(
              connectorRefs,
              connectorRef,
              enabled,
            ),
            unattendedPermissionPolicy: trigger.unattendedPermissionPolicy,
          },
          pageSignal,
        );
        onPolicyChanged?.();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className={containerClass}>
      <ConnectorPickerIntro layout={layout} />
      <div className="relative w-full">
        <IconSearch
          size={15}
          stroke={1.5}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          placeholder="Search connectors"
          className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
            }}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Clear connector search"
          >
            <IconX size={13} stroke={1.8} />
          </button>
        ) : null}
      </div>
      <ConnectorPickerList
        agentId={agentId}
        connectorRefs={connectorRefs}
        connectorsLoading={
          layout === "dialog" && connectorTypesLoadable.state === "loading"
        }
        layout={layout}
        onConfigureConnector={onConfigureConnector}
        onSelectConnector={onSelectConnector}
        onToggleConnector={handleToggleConnector}
        saving={saving}
        trigger={trigger}
        triggerId={triggerId}
        visibleConnectors={visibleConnectors}
        workflowId={workflowId}
      />
    </div>
  );
}

function PermissionToggle({
  action,
  disabled,
  onChange,
}: {
  action: TriggerPermissionPolicyState;
  disabled: boolean;
  onChange: (action: UnattendedTriggerPermissionAction) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {action === "mixed" && <PermissionPolicyMixedBadge />}
      <PermissionPolicyToggle
        policy={action}
        disabled={disabled}
        onAllow={() => {
          onChange("allow");
        }}
        onDeny={() => {
          onChange("deny");
        }}
      />
    </div>
  );
}

function hasDirtyTriggerPermissionOverride({
  overrides,
  savedPolicy,
  connectorRef,
  metadata,
}: {
  readonly overrides: Record<string, UnattendedTriggerPermissionAction>;
  readonly savedPolicy: UnattendedTriggerPermissionPolicy | null;
  readonly connectorRef: string;
  readonly metadata: FirewallPermissionDetailMetadata;
}): boolean {
  return metadata.permissions.some((permission) => {
    const override = overrides[permission.name];
    if (override === undefined) {
      return false;
    }
    return (
      override !==
      resolveTriggerPermissionAction(
        savedPolicy,
        connectorRef,
        metadata,
        permission.name,
      )
    );
  });
}

function materializeTriggerPermissionPolicies(
  metadata: FirewallPermissionDetailMetadata,
  actionFor: (permission: string) => UnattendedTriggerPermissionAction,
): Record<string, UnattendedTriggerPermissionAction> {
  const policies: Record<string, UnattendedTriggerPermissionAction> = {};
  for (const permission of metadata.permissions) {
    policies[permission.name] = actionFor(permission.name);
  }
  return policies;
}

function ConnectorAccessCard({
  connectorEnabled,
  connectorLabel,
  saving,
  onToggle,
}: {
  readonly connectorEnabled: boolean;
  readonly connectorLabel: string;
  readonly saving: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
      <div className="min-w-0 flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">Connector access</p>
        <p className="text-xs text-muted-foreground">
          {connectorEnabled
            ? "Enabled for unattended trigger runs"
            : "Disabled for unattended trigger runs"}
        </p>
      </div>
      <LoadingSwitch
        checked={connectorEnabled}
        loading={saving}
        ariaLabel={`${connectorEnabled ? "Disable" : "Enable"} ${
          connectorLabel
        }`}
        onCheckedChange={onToggle}
      />
    </div>
  );
}

function groupActionFor(
  permissions: readonly ConnectorPermission[],
  actionFor: (permission: string) => UnattendedTriggerPermissionAction,
): TriggerPermissionPolicyState {
  const first = permissions[0];
  if (!first) {
    return "deny";
  }
  const action = actionFor(first.name);
  return permissions.every((permission) => {
    return actionFor(permission.name) === action;
  })
    ? action
    : "mixed";
}

function PermissionRow({
  permission,
  action,
  saving,
  onChange,
}: {
  readonly permission: ConnectorPermission;
  readonly action: UnattendedTriggerPermissionAction;
  readonly saving: boolean;
  readonly onChange: (action: UnattendedTriggerPermissionAction) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <code className="block whitespace-normal break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]">
          {permission.name}
        </code>
        {permission.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {permission.description}
          </p>
        )}
      </div>
      <PermissionToggle action={action} disabled={saving} onChange={onChange} />
    </div>
  );
}

function PermissionGroup({
  group,
  expanded,
  saving,
  actionFor,
  onToggle,
  onGroupChange,
  onPermissionChange,
}: {
  readonly group: TriggerPermissionGroup;
  readonly expanded: boolean;
  readonly saving: boolean;
  readonly actionFor: (permission: string) => UnattendedTriggerPermissionAction;
  readonly onToggle: () => void;
  readonly onGroupChange: (action: UnattendedTriggerPermissionAction) => void;
  readonly onPermissionChange: (
    permission: string,
    action: UnattendedTriggerPermissionAction,
  ) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-foreground transition-colors hover:text-foreground/80"
        >
          <IconChevronRight
            size={14}
            stroke={2}
            className={`shrink-0 transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <span className="truncate">
            {group.category} ({group.permissions.length})
          </span>
        </button>
        <div className="ml-auto">
          <PermissionToggle
            action={groupActionFor(group.permissions, actionFor)}
            disabled={saving}
            onChange={onGroupChange}
          />
        </div>
      </div>
      {expanded &&
        group.permissions.map((permission, index) => {
          return (
            <div key={permission.name}>
              {index > 0 && <div className="mx-3 border-t border-border/40" />}
              <div className="pl-5">
                <PermissionRow
                  permission={permission}
                  action={actionFor(permission.name)}
                  saving={saving}
                  onChange={(action) => {
                    onPermissionChange(permission.name, action);
                  }}
                />
              </div>
            </div>
          );
        })}
    </div>
  );
}

function PermissionsList({
  permissions,
  groups,
  expandedGroups,
  searchActive,
  saving,
  actionFor,
  onToggleGroup,
  onGroupChange,
  onPermissionChange,
}: {
  readonly permissions: ConnectorPermission[];
  readonly groups: TriggerPermissionGroup[] | null;
  readonly expandedGroups: ReadonlySet<string>;
  readonly searchActive: boolean;
  readonly saving: boolean;
  readonly actionFor: (permission: string) => UnattendedTriggerPermissionAction;
  readonly onToggleGroup: (category: string) => void;
  readonly onGroupChange: (
    permissions: readonly ConnectorPermission[],
    action: UnattendedTriggerPermissionAction,
  ) => void;
  readonly onPermissionChange: (
    permission: string,
    action: UnattendedTriggerPermissionAction,
  ) => void;
}) {
  if (permissions.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">
        No permissions found
      </p>
    );
  }

  if (groups && !searchActive) {
    return (
      <>
        {groups.map((group, index) => {
          return (
            <div key={group.category}>
              {index > 0 && <div className="mx-3 border-t border-border/40" />}
              <PermissionGroup
                group={group}
                expanded={expandedGroups.has(group.category)}
                saving={saving}
                actionFor={actionFor}
                onToggle={() => {
                  onToggleGroup(group.category);
                }}
                onGroupChange={(action) => {
                  onGroupChange(group.permissions, action);
                }}
                onPermissionChange={onPermissionChange}
              />
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {permissions.map((permission, index) => {
        return (
          <div key={permission.name}>
            {index > 0 && <div className="mx-3 border-t border-border/40" />}
            <PermissionRow
              permission={permission}
              action={actionFor(permission.name)}
              saving={saving}
              onChange={(action) => {
                onPermissionChange(permission.name, action);
              }}
            />
          </div>
        );
      })}
    </>
  );
}

function useTriggerPermissionEditorModel({
  triggerId,
  connectorRef,
  metadata,
  savedPolicy,
  editor,
}: {
  readonly triggerId: string;
  readonly connectorRef: string;
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly savedPolicy: UnattendedTriggerPermissionPolicy | null;
  readonly editor: TriggerPermissionEditorSignals;
}) {
  const overrides = useGet(editor.overrides$);
  const setOverride = useSet(editor.setOverride$);
  const rawUiState = useGet(triggerPermissionEditorUiState$);
  const setSearch = useSet(setTriggerPermissionEditorSearch$);
  const setScrolled = useSet(setTriggerPermissionEditorScrolled$);
  const toggleGroup = useSet(toggleTriggerPermissionEditorGroup$);
  const permissions = sortedPermissionsForMetadata(metadata);
  const groups = buildSortedGroups(metadata);
  const stateKey = `${triggerId}\u0000${connectorRef}`;
  const uiState = triggerPermissionEditorUiStateForKey({
    current: rawUiState,
    key: stateKey,
    expandedGroups:
      groups?.map((group) => {
        return group.category;
      }) ?? [],
  });
  const normalizedSearch = uiState.search.trim().toLowerCase();
  const searchActive = normalizedSearch.length > 0;
  const displayedPermissions = filterPermissionsForSearch(
    permissions,
    normalizedSearch,
  );
  const displayedGroups = searchActive ? null : groups;
  const actionFor = (permission: string): UnattendedTriggerPermissionAction => {
    return (
      overrides[permission] ??
      resolveTriggerPermissionAction(
        savedPolicy,
        connectorRef,
        metadata,
        permission,
      )
    );
  };
  const dirty = hasDirtyTriggerPermissionOverride({
    overrides,
    savedPolicy,
    connectorRef,
    metadata,
  });

  const handleToggleGroup = (category: string) => {
    toggleGroup(stateKey, category);
  };

  const handleGroupChange = (
    permissionsToSet: readonly ConnectorPermission[],
    action: UnattendedTriggerPermissionAction,
  ) => {
    for (const permission of permissionsToSet) {
      setOverride(permission.name, action);
    }
  };

  const handlePermissionChange = (
    permission: string,
    action: UnattendedTriggerPermissionAction,
  ) => {
    setOverride(permission, action);
  };

  return {
    actionFor,
    dirty,
    displayedGroups,
    displayedPermissions,
    expandedGroups: uiState.expandedGroups,
    handleGroupChange,
    handlePermissionChange,
    handleToggleGroup,
    scrolled: uiState.scrolled,
    search: uiState.search,
    searchActive,
    setScrolled: (scrolled: boolean) => {
      setScrolled(stateKey, scrolled);
    },
    setSearch: (search: string) => {
      setSearch(stateKey, search);
    },
  };
}

function ConnectorPermissionEditorHeader({
  connectorRef,
  connectorLabel,
  connectorHelpText,
  layout,
  onBackToConnectors,
}: {
  readonly connectorRef: string;
  readonly connectorLabel: string;
  readonly connectorHelpText: string;
  readonly layout: TriggerPermissionsLayout;
  readonly onBackToConnectors?: () => void;
}) {
  return (
    <>
      {layout === "page" && (
        <div className="flex items-center gap-3">
          {isFirewallMetadataConnectorType(connectorRef) && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
              <ConnectorIcon type={connectorRef as ConnectorType} size={20} />
            </span>
          )}
          <div className="min-w-0 flex flex-1 flex-col gap-1">
            <p className="text-base font-medium text-foreground">
              {connectorLabel}
            </p>
            <p className="text-xs text-muted-foreground">
              Choose which {connectorLabel} permissions this trigger may use
              when it runs unattended.
            </p>
          </div>
        </div>
      )}

      {layout === "drawer" && onBackToConnectors && (
        <button
          type="button"
          onClick={onBackToConnectors}
          className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconArrowLeft size={13} stroke={1.6} />
          All connectors
        </button>
      )}

      {connectorHelpText && layout === "page" && (
        <p className="text-xs text-muted-foreground">{connectorHelpText}</p>
      )}
    </>
  );
}

function TriggerPermissionSearchBar({
  search,
  scrolled,
  onSearchChange,
}: {
  readonly search: string;
  readonly scrolled: boolean;
  readonly onSearchChange: (value: string) => void;
}) {
  return (
    <div
      className={`-mx-6 flex flex-col gap-2 px-6 pb-3 transition-shadow ${
        scrolled ? "shadow-[0_4px_8px_-4px_rgba(0,0,0,0.08)]" : ""
      }`}
    >
      <div className="relative w-full">
        <IconSearch
          size={15}
          stroke={1.5}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <input
          value={search}
          onChange={(event) => {
            onSearchChange(event.currentTarget.value);
          }}
          aria-label="Find permissions"
          placeholder="Find permissions..."
          className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
        />
        {search && (
          <button
            type="button"
            onClick={() => {
              onSearchChange("");
            }}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Clear permission search"
          >
            <IconX size={13} stroke={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}

function TriggerPermissionEditorFooter({
  layout,
  saved,
  dirty,
  saving,
  onCancel,
  onSave,
}: {
  readonly layout: TriggerPermissionsLayout;
  readonly saved: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onCancel?: () => void;
  readonly onSave: () => void;
}) {
  if (layout === "drawer") {
    return (
      <SheetFooter className="-mx-6 -mb-6 border-t border-border/50 px-6 py-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
          className="h-9 rounded-[10px]"
        >
          {saving ? "Applying..." : "Apply"}
        </Button>
      </SheetFooter>
    );
  }

  if (layout === "dialog") {
    return (
      <DialogFooter className="-mx-6 -mb-6 border-t border-border/50 px-6 py-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
          className="h-9 rounded-[10px]"
        >
          {saving ? "Applying..." : "Apply"}
        </Button>
      </DialogFooter>
    );
  }

  return (
    <div className="flex items-center justify-end gap-3">
      {saved && !dirty && (
        <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-400">
          <IconCheck size={16} />
          Saved
        </span>
      )}
      <Button
        type="button"
        onClick={onSave}
        disabled={saving || !dirty}
        className="h-9 rounded-[10px]"
      >
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}

function useConnectorPermissionEditorActions({
  triggerId,
  connectorRef,
  metadata,
  connectorRefs,
  savedPolicy,
  actionFor,
  onApplied,
  onPolicyChanged,
}: {
  readonly triggerId: string;
  readonly connectorRef: string;
  readonly metadata: FirewallPermissionDetailMetadata;
  readonly connectorRefs: UnattendedTriggerConnectorRefs;
  readonly savedPolicy: UnattendedTriggerPermissionPolicy | null;
  readonly actionFor: (permission: string) => UnattendedTriggerPermissionAction;
  readonly onApplied?: () => void;
  readonly onPolicyChanged?: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, save] = useLoadableSet(
    setWorkflowTriggerPermissionPolicy$,
  );
  const saving = saveLoadable.state === "loading";
  const saved = saveLoadable.state === "hasData";

  const handleSave = () => {
    const merged = mergeConnectorPolicy(
      savedPolicy,
      connectorRef,
      metadata,
      materializeTriggerPermissionPolicies(metadata, actionFor),
    );
    detach(
      (async () => {
        await save(
          {
            triggerId,
            unattendedConnectorRefs: connectorRefs,
            unattendedPermissionPolicy: merged,
          },
          pageSignal,
        );
        onPolicyChanged?.();
        onApplied?.();
      })(),
      Reason.DomCallback,
    );
  };

  const handleToggleConnector = (enabled: boolean) => {
    detach(
      (async () => {
        await save(
          {
            triggerId,
            unattendedConnectorRefs: toggleConnectorRef(
              connectorRefs,
              connectorRef,
              enabled,
            ),
            unattendedPermissionPolicy: savedPolicy,
          },
          pageSignal,
        );
        onPolicyChanged?.();
      })(),
      Reason.DomCallback,
    );
  };

  return { handleSave, handleToggleConnector, saved, saving };
}

function ConnectorPermissionEditorCard({
  triggerId,
  connectorRef,
  metadata,
  connectorRefs,
  savedPolicy,
  editor,
  layout = "page",
  onBackToConnectors,
  onApplied,
  onPolicyChanged,
}: {
  triggerId: string;
  connectorRef: string;
  metadata: FirewallPermissionDetailMetadata;
  connectorRefs: UnattendedTriggerConnectorRefs;
  savedPolicy: UnattendedTriggerPermissionPolicy | null;
  editor: TriggerPermissionEditorSignals;
  layout?: TriggerPermissionsLayout;
  onBackToConnectors?: () => void;
  onApplied?: () => void;
  onPolicyChanged?: () => void;
}) {
  const connectorConfig = isFirewallMetadataConnectorType(connectorRef)
    ? CONNECTOR_TYPES[connectorRef as ConnectorType]
    : undefined;
  const connectorLabel = connectorConfig?.label ?? metadata.label;
  const connectorHelpText = connectorConfig?.helpText ?? "";
  const connectorEnabled = connectorRefs.includes(connectorRef);
  const model = useTriggerPermissionEditorModel({
    connectorRef,
    editor,
    metadata,
    savedPolicy,
    triggerId,
  });
  const { handleSave, handleToggleConnector, saved, saving } =
    useConnectorPermissionEditorActions({
      actionFor: model.actionFor,
      connectorRef,
      connectorRefs,
      metadata,
      onApplied,
      onPolicyChanged,
      savedPolicy,
      triggerId,
    });
  const containerClass =
    layout === "page"
      ? "mx-auto flex w-full max-w-[640px] flex-col gap-4 px-6 py-10"
      : "flex min-h-0 flex-1 flex-col gap-4";

  return (
    <div className={containerClass}>
      <ConnectorPermissionEditorHeader
        connectorRef={connectorRef}
        connectorLabel={connectorLabel}
        connectorHelpText={connectorHelpText}
        layout={layout}
        onBackToConnectors={onBackToConnectors}
      />
      {layout === "dialog" ? null : (
        <ConnectorAccessCard
          connectorEnabled={connectorEnabled}
          connectorLabel={connectorLabel}
          saving={saving}
          onToggle={handleToggleConnector}
        />
      )}
      <TriggerPermissionSearchBar
        search={model.search}
        scrolled={model.scrolled}
        onSearchChange={model.setSearch}
      />

      <div
        className={`min-h-0 flex-1 overflow-y-auto -mx-6 px-3 ${
          model.displayedGroups ? "pt-1" : ""
        }`}
        onScroll={(event) => {
          model.setScrolled(event.currentTarget.scrollTop > 0);
        }}
      >
        <PermissionsList
          permissions={model.displayedPermissions}
          groups={model.displayedGroups}
          expandedGroups={model.expandedGroups}
          searchActive={model.searchActive}
          saving={saving}
          actionFor={model.actionFor}
          onToggleGroup={model.handleToggleGroup}
          onGroupChange={model.handleGroupChange}
          onPermissionChange={model.handlePermissionChange}
        />
      </div>

      <TriggerPermissionEditorFooter
        layout={layout}
        saved={saved}
        dirty={model.dirty}
        saving={saving}
        onCancel={onApplied}
        onSave={handleSave}
      />
    </div>
  );
}

function LoadedTriggerPermissionsEditor({
  triggerId,
  trigger,
  connectorRef,
  editor,
  layout = "page",
  onBackToConnectors,
  onApplied,
  onPolicyChanged,
}: {
  triggerId: string;
  trigger: ZeroWorkflowTriggerSummary;
  connectorRef: string;
  editor: TriggerPermissionEditorSignals;
  layout?: TriggerPermissionsLayout;
  onBackToConnectors?: () => void;
  onApplied?: () => void;
  onPolicyChanged?: () => void;
}) {
  const metadataLoadable = useLoadable(
    firewallPermissionMetadataByConnector({ connectorType: connectorRef }),
  );

  if (metadataLoadable.state === "loading") {
    return <LoadingState layout={layout} />;
  }

  if (metadataLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load permission metadata" />;
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
      connectorRefs={trigger.unattendedConnectorRefs}
      savedPolicy={trigger.unattendedPermissionPolicy}
      editor={editor}
      layout={layout}
      onBackToConnectors={onBackToConnectors}
      onApplied={onApplied}
      onPolicyChanged={onPolicyChanged}
    />
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

  if (triggerLoadable.state === "loading") {
    return <LoadingCard />;
  }

  if (triggerLoadable.state === "hasError") {
    return <ErrorMessage message="Failed to load trigger" />;
  }

  const trigger = triggerLoadable.data;
  if (!trigger) {
    return <ErrorMessage message="Trigger not found" />;
  }

  return (
    <LoadedTriggerPermissionsEditor
      triggerId={triggerId}
      trigger={trigger}
      connectorRef={connectorRef}
      editor={editor}
    />
  );
}

function TriggerPermissionsDrawerContent({
  agentId,
  workflowId,
  trigger,
  onClose,
}: {
  readonly agentId: string;
  readonly workflowId: string;
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly onClose: () => void;
}) {
  const defaultConnectorRef = defaultConnectorRefForTrigger(trigger);
  const drawerConnectorState = useGet(triggerPermissionsDrawerConnector$);
  const setDrawerConnector = useSet(setTriggerPermissionsDrawerConnector$);
  const connectorRefValue = triggerPermissionsDrawerConnectorForTrigger({
    current: drawerConnectorState,
    triggerId: trigger.id,
    defaultConnectorRef,
  });
  const connectorRef =
    connectorRefValue && isFirewallMetadataConnectorType(connectorRefValue)
      ? (connectorRefValue as ConnectorType)
      : null;
  const editor = connectorRef
    ? triggerPermissionEditorSignalsForKey(`${trigger.id}\u0000${connectorRef}`)
    : null;
  const connectorConfig = connectorRef ? CONNECTOR_TYPES[connectorRef] : null;

  const setConnectorRef = (nextConnectorRef: ConnectorType | null) => {
    setDrawerConnector(trigger.id, nextConnectorRef);
  };

  return (
    <>
      <SheetHeader className="shrink-0">
        <div className="flex items-center gap-3">
          {connectorRef && <ConnectorIcon type={connectorRef} size={24} />}
          <SheetTitle className="text-base">
            {connectorConfig
              ? `${connectorConfig.label} permissions`
              : "Trigger permissions"}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              for this trigger
            </span>
          </SheetTitle>
        </div>
        <SheetDescription>
          {triggerContextText(trigger)}. Choose what this trigger may use when
          it runs unattended.
        </SheetDescription>
      </SheetHeader>

      {connectorRef && editor ? (
        <LoadedTriggerPermissionsEditor
          triggerId={trigger.id}
          trigger={trigger}
          connectorRef={connectorRef}
          editor={editor}
          layout="drawer"
          onBackToConnectors={() => {
            setConnectorRef(null);
          }}
          onApplied={onClose}
        />
      ) : (
        <ConnectorPicker
          agentId={agentId}
          workflowId={workflowId}
          triggerId={trigger.id}
          trigger={trigger}
          layout="drawer"
          onSelectConnector={(nextConnectorRef) => {
            setConnectorRef(nextConnectorRef);
          }}
        />
      )}
    </>
  );
}

export function TriggerPermissionsDrawer({
  agentId,
  workflowId,
  trigger,
  open,
  onOpenChange,
}: {
  readonly agentId: string;
  readonly workflowId: string;
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[calc(100vw-32px)] flex-col sm:w-[540px] sm:max-w-[540px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <TriggerPermissionsDrawerContent
          agentId={agentId}
          workflowId={workflowId}
          trigger={trigger}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function TriggerConnectorPermissionDialog({
  trigger,
  connectorRef,
  open,
  onOpenChange,
  onPolicyChanged,
}: {
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly connectorRef: ConnectorType | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPolicyChanged?: () => void;
}) {
  const validConnectorRef =
    connectorRef && isFirewallMetadataConnectorType(connectorRef)
      ? connectorRef
      : null;
  const connectorConfig = validConnectorRef
    ? CONNECTOR_TYPES[validConnectorRef]
    : null;
  const editor = validConnectorRef
    ? triggerPermissionEditorSignalsForKey(
        `${trigger.id}\u0000${validConnectorRef}`,
      )
    : null;

  return (
    <Dialog
      open={open && Boolean(validConnectorRef)}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        className="flex max-h-[min(760px,calc(100vh-32px))] flex-col gap-4 sm:max-w-[620px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {validConnectorRef ? (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-muted/40">
                <ConnectorIcon type={validConnectorRef} size={19} />
              </span>
            ) : null}
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">
                {connectorConfig
                  ? `${connectorConfig.label} permissions`
                  : "Connector permissions"}
              </DialogTitle>
              <DialogDescription>
                Choose what this trigger may use when it runs unattended.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {validConnectorRef && editor ? (
          <LoadedTriggerPermissionsEditor
            triggerId={trigger.id}
            trigger={trigger}
            connectorRef={validConnectorRef}
            editor={editor}
            layout="dialog"
            onApplied={() => {
              onOpenChange(false);
            }}
            onPolicyChanged={onPolicyChanged}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function TriggerPermissionsDialog({
  agentId,
  workflowId,
  trigger,
  open,
  onOpenChange,
  onPolicyChanged,
}: {
  readonly agentId: string;
  readonly workflowId: string;
  readonly trigger: ZeroWorkflowTriggerSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPolicyChanged?: () => void;
}) {
  const connectorRefValue = useGet(triggerPermissionsDialogConnectorRef$);
  const setConnectorRef = useSet(setTriggerPermissionsDialogConnectorRef$);
  const connectorRef =
    connectorRefValue && isFirewallMetadataConnectorType(connectorRefValue)
      ? connectorRefValue
      : null;
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setConnectorRef(null);
    }
    onOpenChange(nextOpen);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex max-h-[min(680px,calc(100vh-32px))] flex-col gap-4 sm:max-w-[560px]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Trigger permissions</DialogTitle>
            <DialogDescription>
              {triggerContextText(trigger)}. Choose which connected connectors
              this trigger may use.
            </DialogDescription>
          </DialogHeader>
          <ConnectorPicker
            agentId={agentId}
            workflowId={workflowId}
            triggerId={trigger.id}
            trigger={trigger}
            layout="dialog"
            onConfigureConnector={(nextConnectorRef) => {
              setConnectorRef(nextConnectorRef);
            }}
            onPolicyChanged={onPolicyChanged}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                handleOpenChange(false);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TriggerConnectorPermissionDialog
        trigger={trigger}
        connectorRef={connectorRef}
        open={open && connectorRef !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setConnectorRef(null);
          }
        }}
        onPolicyChanged={onPolicyChanged}
      />
    </>
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
