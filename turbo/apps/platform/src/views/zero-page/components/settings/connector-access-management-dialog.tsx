import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAdjustmentsHorizontal,
  IconLoader2,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@vm0/ui";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  hasFirewallMetadataPermissions,
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
  type FirewallPermissionDetailMetadata,
} from "@vm0/connectors/firewall-metadata";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { firewallPermissionMetadataByConnector } from "../../../../signals/firewall-permission-metadata.ts";
import { applyUserPermissionGrants$ } from "../../../../signals/permission-allow/permission-allow-signals.ts";
import {
  connectorAgentAccessRows,
  connectorAccessManagementPermissionAgentId$,
  connectorAccessManagementSavingAgentId$,
  connectorAccessManagementSearch$,
  setConnectorAgentAuthorization$,
  setConnectorAccessManagementPermissionAgentId$,
  setConnectorAccessManagementSavingAgentId$,
  setConnectorAccessManagementSearch$,
  type ConnectorAgentAccessRow,
} from "../../../../signals/zero-page/settings/connector-access-management.ts";
import {
  savePermissionDraftPolicies,
  type ApplyUserPermissionGrants,
} from "../../../../signals/zero-page/settings/permission-grant-save.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { LoadingSwitch } from "../../../components/loading-switch.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import { AvatarFromUrl } from "../../zero-sidebar-shared.tsx";
import { ConnectorIcon } from "./connector-icons.tsx";
import { PermissionsDialog } from "./permissions-dialog.tsx";

const VISIBLE_PERMISSION_CHIPS = 3;

interface ConnectorAccessManagementDialogProps {
  readonly connectorType: ConnectorType;
  readonly onClose: () => void;
}

function agentName(agent: TeamComposeItem): string {
  return agent.displayName ?? "Unnamed";
}

function filterRows(
  rows: readonly ConnectorAgentAccessRow[],
  search: string,
): readonly ConnectorAgentAccessRow[] {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) {
    return rows;
  }
  return rows.filter((row) => {
    return agentName(row.agent).toLowerCase().includes(normalizedSearch);
  });
}

function allowedPermissionNames({
  connectorType,
  grants,
  metadata,
}: {
  readonly connectorType: ConnectorType;
  readonly grants: readonly UserPermissionGrantResponse[];
  readonly metadata: FirewallPermissionDetailMetadata;
}): readonly string[] {
  const resolved = resolveFirewallMetadataPolicies(
    permissionGrantsToFirewallPolicies(grants),
    [metadata],
  )?.[connectorType];
  return metadata.permissions
    .filter((permission) => {
      return resolved?.policies[permission.name] === "allow";
    })
    .map((permission) => {
      return permission.name;
    });
}

function ConnectorAccessSearch({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <IconSearch
        size={15}
        stroke={1.5}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
      />
      <input
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        aria-label="Find agents"
        placeholder="Find agents"
        className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange("");
          }}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Clear agent search"
        >
          <IconX size={13} stroke={1.8} />
        </button>
      )}
    </div>
  );
}

function PermissionChips({
  connectorType,
  grants,
  metadata,
}: {
  readonly connectorType: ConnectorType;
  readonly grants: readonly UserPermissionGrantResponse[];
  readonly metadata: FirewallPermissionDetailMetadata;
}) {
  const allowed = allowedPermissionNames({ connectorType, grants, metadata });
  const visible = allowed.slice(0, VISIBLE_PERMISSION_CHIPS);
  const remaining = allowed.length - visible.length;

  if (allowed.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        No allow permissions
      </span>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {visible.map((name) => {
        return (
          <span
            key={name}
            className="max-w-[180px] truncate rounded-md bg-muted px-2 py-1 text-xs text-foreground"
            title={name}
          >
            {name}
          </span>
        );
      })}
      {remaining > 0 && (
        <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          +{remaining} more
        </span>
      )}
    </div>
  );
}

function AuthorizedPermissionsPreview({
  connectorType,
  grants,
  metadata,
  metadataLoading,
  metadataError,
}: {
  readonly connectorType: ConnectorType;
  readonly grants: readonly UserPermissionGrantResponse[];
  readonly metadata: FirewallPermissionDetailMetadata | null;
  readonly metadataLoading: boolean;
  readonly metadataError: boolean;
}) {
  if (metadataLoading) {
    return (
      <span className="text-xs text-muted-foreground">
        Loading permissions...
      </span>
    );
  }
  if (metadataError) {
    return (
      <span className="text-xs text-destructive">
        Failed to load permissions
      </span>
    );
  }
  if (!metadata) {
    return (
      <span className="text-xs text-muted-foreground">
        No configurable permissions
      </span>
    );
  }
  return (
    <PermissionChips
      connectorType={connectorType}
      grants={grants}
      metadata={metadata}
    />
  );
}

function AgentAccessRow({
  row,
  connectorType,
  connectorLabel,
  metadata,
  metadataLoading,
  metadataError,
  saving,
  onToggle,
  onManage,
}: {
  readonly row: ConnectorAgentAccessRow;
  readonly connectorType: ConnectorType;
  readonly connectorLabel: string;
  readonly metadata: FirewallPermissionDetailMetadata | null;
  readonly metadataLoading: boolean;
  readonly metadataError: boolean;
  readonly saving: boolean;
  readonly onToggle: (
    row: ConnectorAgentAccessRow,
    authorized: boolean,
  ) => void;
  readonly onManage: (row: ConnectorAgentAccessRow) => void;
}) {
  const name = agentName(row.agent);
  const canManage = row.authorized && metadata !== null;
  const showPermissions =
    row.authorized && hasFirewallMetadataPermissions(connectorType);

  return (
    <div className="flex flex-col gap-3 border-b border-border/50 px-1 py-4 last:border-b-0">
      <div className="flex items-center gap-3">
        <AvatarFromUrl
          avatarUrl={row.agent.avatarUrl}
          alt={name}
          className="h-9 w-9 shrink-0 rounded-full object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
        </div>
        <p className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {row.authorized ? "Authorized" : "Not authorized"}
        </p>
        <LoadingSwitch
          checked={row.authorized}
          loading={saving}
          onCheckedChange={(checked) => {
            onToggle(row, checked);
          }}
          ariaLabel={`${row.authorized ? "Revoke" : "Authorize"} ${connectorLabel} access for ${name}`}
        />
      </div>

      {showPermissions && (
        <div className="ml-12 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <AuthorizedPermissionsPreview
              connectorType={connectorType}
              grants={row.grants}
              metadata={metadata}
              metadataLoading={metadataLoading}
              metadataError={metadataError}
            />
          </div>
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              onClick={() => {
                onManage(row);
              }}
            >
              <IconAdjustmentsHorizontal size={14} stroke={1.5} />
              Manage
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function AgentAccessList({
  rows,
  connectorType,
  connectorLabel,
  metadata,
  metadataLoading,
  metadataError,
  savingAgentId,
  search,
  onToggle,
  onManage,
}: {
  readonly rows: readonly ConnectorAgentAccessRow[];
  readonly connectorType: ConnectorType;
  readonly connectorLabel: string;
  readonly metadata: FirewallPermissionDetailMetadata | null;
  readonly metadataLoading: boolean;
  readonly metadataError: boolean;
  readonly savingAgentId: string | null;
  readonly search: string;
  readonly onToggle: (
    row: ConnectorAgentAccessRow,
    authorized: boolean,
  ) => void;
  readonly onManage: (row: ConnectorAgentAccessRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {search.trim()
          ? `No agents matching "${search.trim()}"`
          : "No agents found"}
      </p>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1">
      {rows.map((row) => {
        return (
          <AgentAccessRow
            key={row.agent.id}
            row={row}
            connectorType={connectorType}
            connectorLabel={connectorLabel}
            metadata={metadata}
            metadataLoading={metadataLoading}
            metadataError={metadataError}
            saving={savingAgentId === row.agent.id}
            onToggle={onToggle}
            onManage={onManage}
          />
        );
      })}
    </div>
  );
}

function LoadingAgents() {
  return (
    <div className="flex min-h-[240px] flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <IconLoader2 size={16} className="animate-spin" />
      Loading agents...
    </div>
  );
}

function ConnectorAccessDialog({
  onClose,
  connectorType,
  connectorLabel,
  rows,
  rowsLoaded,
  metadata,
  metadataLoading,
  metadataError,
  savingAgentId,
  search,
  onSearchChange,
  onToggle,
  onManage,
}: {
  readonly onClose: () => void;
  readonly connectorType: ConnectorType;
  readonly connectorLabel: string;
  readonly rows: readonly ConnectorAgentAccessRow[];
  readonly rowsLoaded: boolean;
  readonly metadata: FirewallPermissionDetailMetadata | null;
  readonly metadataLoading: boolean;
  readonly metadataError: boolean;
  readonly savingAgentId: string | null;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly onToggle: (
    row: ConnectorAgentAccessRow,
    authorized: boolean,
  ) => void;
  readonly onManage: (row: ConnectorAgentAccessRow) => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onClose();
      }}
    >
      <DialogContent className="!flex h-[min(720px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[720px] !flex-col !overflow-hidden">
        <DialogHeader className="shrink-0 gap-2">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <ConnectorIcon type={connectorType} size={22} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                Manage {connectorLabel} access
              </DialogTitle>
              <DialogDescription>
                Choose which agents can use this connector.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="shrink-0">
          <ConnectorAccessSearch value={search} onChange={onSearchChange} />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-hidden rounded-lg px-3",
            !rowsLoaded && "flex",
            rowsLoaded && "flex flex-col",
          )}
        >
          {rowsLoaded ? (
            <AgentAccessList
              rows={rows}
              connectorType={connectorType}
              connectorLabel={connectorLabel}
              metadata={metadata}
              metadataLoading={metadataLoading}
              metadataError={metadataError}
              savingAgentId={savingAgentId}
              search={search}
              onToggle={onToggle}
              onManage={onManage}
            />
          ) : (
            <LoadingAgents />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentPermissionDialog({
  row,
  metadata,
  connectorType,
  pageSignal,
  applyGrantPolicies,
  onClose,
}: {
  readonly row: ConnectorAgentAccessRow | undefined;
  readonly metadata: FirewallPermissionDetailMetadata | null;
  readonly connectorType: ConnectorType;
  readonly pageSignal: AbortSignal;
  readonly applyGrantPolicies: ApplyUserPermissionGrants;
  readonly onClose: () => void;
}) {
  if (!row || !metadata) {
    return null;
  }
  const initialPolicies = permissionGrantsToFirewallPolicies(row.grants) ?? {};

  return (
    <PermissionsDialog
      agentId={row.agent.id}
      connectorType={connectorType}
      displayName={agentName(row.agent)}
      initialPolicies={initialPolicies}
      initialGrants={row.grants}
      resetEnabled
      readOnly={false}
      onApply={async (intent, { metadata: appliedMetadata }) => {
        await savePermissionDraftPolicies({
          scope: { agentId: row.agent.id },
          connectorType,
          metadata: appliedMetadata,
          initialPolicies,
          initialGrants: row.grants,
          intent,
          pageSignal,
          applyGrantPolicies,
        });
        toast.success("Permissions updated");
      }}
      onClose={onClose}
    />
  );
}

export function ConnectorAccessManagementDialog({
  connectorType,
  onClose,
}: ConnectorAccessManagementDialogProps) {
  const connector = CONNECTOR_TYPES[connectorType];
  const rowsLoadable = useLastLoadable(
    connectorAgentAccessRows({ connectorType }),
  );
  const metadataLoadable = useLastLoadable(
    firewallPermissionMetadataByConnector({ connectorType }),
  );
  const pageSignal = useGet(pageSignal$);
  const search = useGet(connectorAccessManagementSearch$);
  const pendingSavingAgentId = useGet(connectorAccessManagementSavingAgentId$);
  const permissionAgentId = useGet(connectorAccessManagementPermissionAgentId$);
  const setSearch = useSet(setConnectorAccessManagementSearch$);
  const setSavingAgentId = useSet(setConnectorAccessManagementSavingAgentId$);
  const setPermissionAgentId = useSet(
    setConnectorAccessManagementPermissionAgentId$,
  );
  const [authorizationLoadable, setAuthorization] = useLoadableSet(
    setConnectorAgentAuthorization$,
  );
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);
  const rows = rowsLoadable.state === "hasData" ? rowsLoadable.data : [];
  const metadata =
    metadataLoadable.state === "hasData" ? metadataLoadable.data : null;
  const savingAgentId =
    authorizationLoadable.state === "loading" ? pendingSavingAgentId : null;
  const selectedPermissionRow = permissionAgentId
    ? rows.find((row) => {
        return row.agent.id === permissionAgentId && row.authorized;
      })
    : undefined;

  const handleToggle = (row: ConnectorAgentAccessRow, authorized: boolean) => {
    if (savingAgentId !== null) {
      return;
    }
    setSavingAgentId(row.agent.id);
    detach(
      (async () => {
        await setAuthorization(
          { agentId: row.agent.id, connectorType, authorized },
          pageSignal,
        );
        toast.success(`${connector.label} access updated`);
        setSavingAgentId(null);
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <>
      <ConnectorAccessDialog
        onClose={onClose}
        connectorType={connectorType}
        connectorLabel={connector.label}
        rows={filterRows(rows, search)}
        rowsLoaded={rowsLoadable.state === "hasData"}
        metadata={metadata}
        metadataLoading={metadataLoadable.state === "loading"}
        metadataError={metadataLoadable.state === "hasError"}
        savingAgentId={savingAgentId}
        search={search}
        onSearchChange={setSearch}
        onToggle={handleToggle}
        onManage={(row) => {
          setPermissionAgentId(row.agent.id);
        }}
      />
      <AgentPermissionDialog
        row={selectedPermissionRow}
        metadata={metadata}
        connectorType={connectorType}
        pageSignal={pageSignal}
        applyGrantPolicies={applyGrantPolicies}
        onClose={() => {
          setPermissionAgentId(null);
        }}
      />
    </>
  );
}
