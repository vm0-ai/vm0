import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconCircleCheck,
  IconLoader,
  IconPlus,
  IconDotsVertical,
  IconChevronDown,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type SecretResponse,
  type VariableResponse,
} from "@vm0/core";
import { AppShell } from "../layout/app-shell.tsx";
import { ConnectorIcon } from "../settings-page/connector-icons.tsx";
import { SecretDialog } from "../settings-page/secret-dialog.tsx";
import { VariableDialog } from "../settings-page/variable-dialog.tsx";
import { DeleteSecretDialog } from "../settings-page/delete-secret-dialog.tsx";
import { DeleteVariableDialog } from "../settings-page/delete-variable-dialog.tsx";
import forgotPasswordIcon from "../settings-page/icons/forgot-password.svg";
import type { MergedItem } from "../../signals/settings-page/secrets-and-variables.ts";
import {
  agentDetail$,
  agentDetailLoading$,
  agentName$,
} from "../../signals/agent-detail/agent-detail.ts";
import {
  agentConnectorStatus$,
  agentMergedItems$,
  connectionsActiveTab$,
  setConnectionsActiveTab$,
  type AgentConnectorStatus,
} from "../../signals/agent-detail/connections.ts";
import {
  connectConnector$,
  pollingConnectorType$,
  openDisconnectDialog$,
} from "../../signals/settings-page/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { DisconnectConnectorDialog } from "../settings-page/disconnect-connector-dialog.tsx";
import {
  openAddSecretDialog$,
  openEditSecretDialog$,
  openDeleteSecretDialog$,
} from "../../signals/settings-page/secrets.ts";
import {
  openAddVariableDialog$,
  openEditVariableDialog$,
  openDeleteVariableDialog$,
} from "../../signals/settings-page/variables.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function truncateValue(value: string, maxLength = 60): string {
  return value.length > maxLength
    ? value.substring(0, maxLength) + "..."
    : value;
}

// ---------------------------------------------------------------------------
// Connectors tab
// ---------------------------------------------------------------------------

function ConnectorRow({ item }: { item: AgentConnectorStatus }) {
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const openDisconnect = useSet(openDisconnectDialog$);
  const pageSignal = useGet(pageSignal$);
  const isPolling = pollingType === item.type;

  return (
    <div className="flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 first:rounded-t-xl last:rounded-b-xl last:border-b">
      <div className="shrink-0">
        <ConnectorIcon type={item.type} size={28} />
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{item.label}</div>
        <div className="text-sm text-muted-foreground">{item.helpText}</div>
      </div>

      {/* Status */}
      <div className="shrink-0">
        {item.connected && item.externalUsername && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
            <IconCircleCheck className="h-3 w-3 text-green-600" />
            Connected as {item.externalUsername}
          </span>
        )}
        {item.connected && !item.externalUsername && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
            <IconCircleCheck className="h-3 w-3 text-green-600" />
            Connected
          </span>
        )}
        {!item.connected && isPolling && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
            <IconLoader className="h-3 w-3 text-yellow-600 animate-spin" />
            Connecting...
          </span>
        )}
      </div>

      {/* Action */}
      {item.connected ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="icon-button shrink-0"
              aria-label="Connector options"
            >
              <IconDotsVertical
                size={16}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex flex-col gap-1 w-36 p-2">
            <button
              onClick={() => openDisconnect(item.type)}
              className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Disconnect
            </button>
          </PopoverContent>
        </Popover>
      ) : (
        <button
          onClick={() =>
            detach(connect(item.type, pageSignal), Reason.DomCallback)
          }
          disabled={isPolling}
          className="flex items-center shrink-0 rounded-lg border border-border bg-background overflow-hidden hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="px-4 py-2 text-sm font-medium text-foreground">
            Connect
          </span>
        </button>
      )}
    </div>
  );
}

function ConnectorsTab() {
  const connectorStatus = useLastResolved(agentConnectorStatus$);
  const types = (Object.keys(CONNECTOR_TYPES) as ConnectorType[]).filter(
    (t) => t !== "computer",
  );

  if (!connectorStatus) {
    return (
      <div className="flex flex-col">
        {types.map((type, i) => (
          <div
            key={type}
            className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 animate-pulse ${i === 0 ? "rounded-t-xl" : ""} ${i === types.length - 1 ? "rounded-b-xl border-b" : ""}`}
          >
            <div className="h-7 w-7 rounded bg-muted" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="h-3 w-48 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {connectorStatus.map((item) => (
        <ConnectorRow key={item.type} item={item} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets and variables tab — row components
// ---------------------------------------------------------------------------

function MissingItemRow({
  item,
  isFirst,
}: {
  item: MergedItem;
  isFirst: boolean;
}) {
  const openAddSecret = useSet(openAddSecretDialog$);
  const openAddVariable = useSet(openAddVariableDialog$);

  const badgeLabel =
    item.kind === "secret" ? "Missing secrets" : "Missing variables";

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {item.name}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 rounded-md border border-border bg-background px-1.5 py-0.5">
        <img alt="" src={forgotPasswordIcon} className="size-3" />
        <span className="text-xs font-medium text-muted-foreground">
          {badgeLabel}
        </span>
      </div>
      <button
        onClick={() =>
          item.kind === "secret"
            ? openAddSecret(item.name)
            : openAddVariable(item.name)
        }
        className="shrink-0 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
      >
        Fill
      </button>
    </div>
  );
}

function SecretRow({
  secret,
  agentRequired,
  isFirst,
}: {
  secret: SecretResponse;
  agentRequired: boolean;
  isFirst: boolean;
}) {
  const openEdit = useSet(openEditSecretDialog$);
  const openDelete = useSet(openDeleteSecretDialog$);

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {secret.name}
        </div>
        {secret.description && (
          <div className="text-sm text-muted-foreground">
            {secret.description}
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {formatDate(secret.updatedAt)}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button className="icon-button shrink-0" aria-label="Secret options">
            <IconDotsVertical
              size={16}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex flex-col gap-1 w-36 p-2">
          <button
            onClick={() => openEdit(secret)}
            className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Edit
          </button>
          {!agentRequired && (
            <button
              onClick={() => openDelete(secret.name)}
              className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Delete
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function VariableRow({
  variable,
  agentRequired,
  isFirst,
}: {
  variable: VariableResponse;
  agentRequired: boolean;
  isFirst: boolean;
}) {
  const openEdit = useSet(openEditVariableDialog$);
  const openDelete = useSet(openDeleteVariableDialog$);

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {variable.name}
        </div>
        <div className="text-sm text-muted-foreground font-mono truncate">
          {truncateValue(variable.value)}
        </div>
        {variable.description && (
          <div className="text-xs text-muted-foreground">
            {variable.description}
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {formatDate(variable.updatedAt)}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="icon-button shrink-0"
            aria-label="Variable options"
          >
            <IconDotsVertical
              size={16}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex flex-col gap-1 w-36 p-2">
          <button
            onClick={() => openEdit(variable)}
            className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Edit
          </button>
          {!agentRequired && (
            <button
              onClick={() => openDelete(variable.name)}
              className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Delete
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ItemRow({ item, isFirst }: { item: MergedItem; isFirst: boolean }) {
  if (item.data === null) {
    return <MissingItemRow item={item} isFirst={isFirst} />;
  }

  if (item.kind === "secret") {
    return (
      <SecretRow
        secret={item.data}
        agentRequired={item.agentRequired}
        isFirst={isFirst}
      />
    );
  }

  return (
    <VariableRow
      variable={item.data}
      agentRequired={item.agentRequired}
      isFirst={isFirst}
    />
  );
}

// ---------------------------------------------------------------------------
// Add dropdown
// ---------------------------------------------------------------------------

function AddDropdown() {
  const openAddSecret = useSet(openAddSecretDialog$);
  const openAddVariable = useSet(openAddVariableDialog$);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center self-start shrink-0 rounded-md border border-border bg-background overflow-hidden hover:bg-muted transition-colors">
          <span className="border-r border-border px-4 py-2 text-sm font-medium text-foreground">
            Add more secrets
          </span>
          <span className="pl-2 pr-3 py-2">
            <IconChevronDown
              size={16}
              stroke={1.5}
              className="text-foreground"
            />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-1 w-44 p-2">
        <button
          onClick={() => openAddSecret()}
          className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Add secret
        </button>
        <button
          onClick={() => openAddVariable()}
          className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Add variable
        </button>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Secrets and variables tab
// ---------------------------------------------------------------------------

function SecretsAndVariablesTab() {
  const items = useLastResolved(agentMergedItems$);

  if (!items) {
    return (
      <div className="flex flex-col">
        {["sv1", "sv2", "sv3"].map((id, i) => (
          <div
            key={id}
            className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 animate-pulse ${i === 0 ? "rounded-t-xl" : ""} ${i === 2 ? "rounded-b-xl border-b" : ""}`}
          >
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-4 w-32 rounded bg-muted" />
              <div className="h-3 w-48 rounded bg-muted" />
            </div>
            <div className="h-3 w-16 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {items.map((item, index) => (
        <ItemRow
          key={`${item.kind}-${item.name}`}
          item={item}
          isFirst={index === 0}
        />
      ))}

      <div
        className={`flex flex-col gap-4 border border-border bg-card p-4 rounded-b-xl sm:flex-row sm:items-center ${items.length === 0 ? "rounded-t-xl" : ""}`}
      >
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="flex shrink-0 items-center justify-center size-[28px]">
            <IconPlus size={24} stroke={1.5} className="text-foreground" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              New secrets and variables
            </div>
            <div className="text-sm text-muted-foreground">
              Custom API keys and variables
            </div>
          </div>
        </div>
        <AddDropdown />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AgentConnectionsPage() {
  const agentName = useGet(agentName$);
  const detail = useGet(agentDetail$);
  const loading = useGet(agentDetailLoading$);
  const activeTab = useGet(connectionsActiveTab$);
  const setActiveTab = useSet(setConnectionsActiveTab$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        {
          label: agentName ?? "Loading...",
          path: agentName ? "/agents/:name" : undefined,
          pathParams: agentName ? { name: agentName } : undefined,
        },
        "Connections",
      ]}
    >
      <div className="flex flex-col gap-[22px] p-8 min-h-full">
        {loading ? (
          <AgentConnectionsPageSkeleton />
        ) : detail ? (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-medium text-foreground">
                Connections of {detail.name}
              </h2>
              <p className="text-sm text-muted-foreground">
                This is the secret list used for your agents in every run
              </p>
            </div>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="connectors">Connectors</TabsTrigger>
                <TabsTrigger value="secrets">Secrets and variables</TabsTrigger>
              </TabsList>
            </Tabs>
            {activeTab === "connectors" && <ConnectorsTab />}
            {activeTab === "secrets" && <SecretsAndVariablesTab />}
            <SecretDialog />
            <VariableDialog />
            <DeleteSecretDialog />
            <DeleteVariableDialog />
            <DisconnectConnectorDialog />
          </>
        ) : (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">Agent not found</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function AgentConnectionsPageSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-9 w-64 rounded-lg" />
      <div className="flex flex-col">
        {["c1", "c2"].map((id, i) => (
          <div
            key={id}
            className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 animate-pulse ${i === 0 ? "rounded-t-xl" : ""} ${i === 1 ? "rounded-b-xl border-b" : ""}`}
          >
            <div className="h-7 w-7 rounded bg-muted" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="h-3 w-48 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
