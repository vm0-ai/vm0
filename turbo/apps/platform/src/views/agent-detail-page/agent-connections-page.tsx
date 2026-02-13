import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconCircleCheck,
  IconLoader,
  IconAlertCircle,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { AppShell } from "../layout/app-shell.tsx";
import { AgentHeader } from "./agent-header.tsx";
import { ConnectorIcon } from "../settings-page/connector-icons.tsx";
import { SecretDialog } from "../settings-page/secret-dialog.tsx";
import {
  agentDetail$,
  agentDetailLoading$,
  agentName$,
  isOwner$,
} from "../../signals/agent-detail/agent-detail.ts";
import {
  agentConnectorStatus$,
  agentSecretStatus$,
  agentVariableStatus$,
  connectionsActiveTab$,
  setConnectionsActiveTab$,
  type AgentConnectorStatus,
  type AgentSecretStatus,
  type AgentVariableStatus,
} from "../../signals/agent-detail/connections.ts";
import {
  connectConnector$,
  pollingConnectorType$,
} from "../../signals/settings-page/connectors.ts";
import { openAddSecretDialog$ } from "../../signals/settings-page/secrets.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

// ---------------------------------------------------------------------------
// Connectors tab
// ---------------------------------------------------------------------------

function ConnectorRow({ item }: { item: AgentConnectorStatus }) {
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
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
      {!item.connected && (
        <button
          onClick={() => connect(item.type, pageSignal)}
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
// Secrets and variables tab
// ---------------------------------------------------------------------------

function SecretStatusRow({ item }: { item: AgentSecretStatus }) {
  const openAddSecret = useSet(openAddSecretDialog$);

  return (
    <div className="flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 first:rounded-t-xl last:rounded-b-xl last:border-b">
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {item.name}
        </div>
      </div>
      {item.configured ? (
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
          <IconCircleCheck className="h-3 w-3 text-green-600" />
          Configured
        </span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-muted-foreground">
            <IconAlertCircle className="h-3 w-3 text-yellow-600" />
            Missing
          </span>
          <button
            onClick={() => openAddSecret(item.name)}
            className="shrink-0 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            Add
          </button>
        </>
      )}
    </div>
  );
}

function VariableStatusRow({ item }: { item: AgentVariableStatus }) {
  return (
    <div className="flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 first:rounded-t-xl last:rounded-b-xl last:border-b">
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {item.name}
        </div>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-muted-foreground">
        Runtime variable
      </span>
    </div>
  );
}

function SecretsAndVariablesTab() {
  const secretStatus = useLastResolved(agentSecretStatus$);
  const variableStatus = useLastResolved(agentVariableStatus$);

  if (!secretStatus || !variableStatus) {
    return (
      <div className="flex flex-col">
        {["s1", "s2", "s3"].map((id, i) => (
          <div
            key={id}
            className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 animate-pulse ${i === 0 ? "rounded-t-xl" : ""} ${i === 2 ? "rounded-b-xl border-b" : ""}`}
          >
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-4 w-32 rounded bg-muted" />
            </div>
            <div className="h-5 w-20 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (secretStatus.length === 0 && variableStatus.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <p className="text-lg">No secrets or variables required</p>
        <p className="mt-2 text-sm">
          This agent does not require any secrets or variables.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {secretStatus.map((item) => (
        <SecretStatusRow key={`secret-${item.name}`} item={item} />
      ))}
      {variableStatus.map((item) => (
        <VariableStatusRow key={`var-${item.name}`} item={item} />
      ))}
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
  const isOwner = useGet(isOwner$);
  const activeTab = useGet(connectionsActiveTab$);
  const setActiveTab = useSet(setConnectionsActiveTab$);

  return (
    <AppShell
      breadcrumb={[
        { label: "Agents", path: "/agents" },
        agentName ?? "Loading...",
        "Connections",
      ]}
    >
      <div className="flex flex-col gap-[22px] p-8 min-h-full">
        {loading ? (
          <AgentConnectionsPageSkeleton />
        ) : detail ? (
          <>
            <AgentHeader detail={detail} isOwner={isOwner} />
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
      <div className="flex items-center gap-3.5">
        <Skeleton className="h-14 w-14 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
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
