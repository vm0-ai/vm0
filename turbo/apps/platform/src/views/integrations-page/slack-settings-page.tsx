import { useGet, useSet } from "ccstate-react";
import { IconAlertTriangle, IconChevronDown } from "@tabler/icons-react";
import {
  CONNECTOR_TYPES,
  getConnectorProvidedSecretNames,
  type ConnectorType,
} from "@vm0/core";
import { Button } from "@vm0/ui/components/ui/button";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { detach, Reason } from "../../signals/utils.ts";
import {
  slackIntegrationData$,
  slackIntegrationLoading$,
  disconnectSlack$,
  updateSlackDefaultAgent$,
  slackDisconnectDialogOpen$,
  openSlackDisconnectDialog$,
  closeSlackDisconnectDialog$,
} from "../../signals/integrations-page/slack-integration.ts";
import { agentsList$ } from "../../signals/agents-page/agents-list.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { AppShell } from "../layout/app-shell.tsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllConnectorEnvVars(): Set<string> {
  return getConnectorProvidedSecretNames(
    Object.keys(CONNECTOR_TYPES) as ConnectorType[],
  );
}

// ---------------------------------------------------------------------------
// Missing env banner
// ---------------------------------------------------------------------------

function MissingEnvBanner({
  missingSecrets,
  missingVars,
}: {
  missingSecrets: string[];
  missingVars: string[];
}) {
  const navigate = useSet(navigateInReact$);
  const envVars = getAllConnectorEnvVars();

  const hasMissingConnectors = missingSecrets.some((s) => envVars.has(s));
  const hasMissingSecretsOrVars =
    missingSecrets.some((s) => !envVars.has(s)) || missingVars.length > 0;

  if (!hasMissingConnectors && !hasMissingSecretsOrVars) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/30">
      <IconAlertTriangle
        size={20}
        className="shrink-0 text-amber-500"
        stroke={1.5}
      />
      <p className="text-sm">
        {"Looks like this agent is missing some "}
        {hasMissingConnectors && (
          <button
            className="font-medium text-amber-600 hover:underline dark:text-amber-500"
            onClick={() =>
              navigate("/settings", {
                searchParams: new URLSearchParams({
                  tab: "connectors",
                }),
              })
            }
          >
            connectors
          </button>
        )}
        {hasMissingConnectors && hasMissingSecretsOrVars && ", "}
        {hasMissingSecretsOrVars && (
          <button
            className="font-medium text-amber-600 hover:underline dark:text-amber-500"
            onClick={() =>
              navigate("/settings", {
                searchParams: new URLSearchParams({
                  tab: "secrets-and-variables",
                }),
              })
            }
          >
            secrets or variables
          </button>
        )}
        {". Add them now so it can run without stopping."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default agent section
// ---------------------------------------------------------------------------

function DefaultAgentSection({
  isAdmin,
  agentName,
  agentOptions,
  onAgentChange,
}: {
  isAdmin: boolean;
  agentName: string | undefined;
  agentOptions: { name: string }[];
  onAgentChange: (name: string) => void;
}) {
  const navigate = useSet(navigateInReact$);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-medium">Default agent</h3>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 flex-col gap-1">
          {isAdmin ? (
            <>
              <p className="text-sm font-medium">
                Default agent you would like to use in Slack
              </p>
              <p className="text-sm text-muted-foreground">
                {
                  "If you want to manage your agent's model provider, secrets, or connectors, go to "
                }
                <button
                  className="text-primary hover:underline"
                  onClick={() =>
                    navigate("/settings", {
                      searchParams: new URLSearchParams({
                        tab: "providers",
                      }),
                    })
                  }
                >
                  Settings
                </button>
                .
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">
                Default agent you use in Slack
              </p>
              <p className="text-sm text-muted-foreground">
                This agent is managed by your Slack workspace admin. To make
                changes, please contact your workspace admin.
              </p>
            </>
          )}
        </div>
        {isAdmin ? (
          <Select value={agentName ?? ""} onValueChange={onAgentChange}>
            <SelectTrigger className="w-full sm:w-[280px] sm:shrink-0">
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 sm:w-[280px] sm:shrink-0">
            <span className="truncate text-sm">{agentName ?? "No agent"}</span>
            <IconChevronDown size={16} className="shrink-0 opacity-50" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SlackSettingsPage() {
  const data = useGet(slackIntegrationData$);
  const loading = useGet(slackIntegrationLoading$);
  const agents = useGet(agentsList$);
  const navigate = useSet(navigateInReact$);
  const disconnect = useSet(disconnectSlack$);
  const updateAgent = useSet(updateSlackDefaultAgent$);
  const confirmOpen = useGet(slackDisconnectDialogOpen$);
  const openConfirm = useSet(openSlackDisconnectDialog$);
  const closeConfirm = useSet(closeSlackDisconnectDialog$);

  // Ensure the current workspace agent appears in the dropdown even if
  // it isn't in the user's own agents list (e.g. shared by another user).
  const agentOptions = (() => {
    if (!data?.agent) {
      return agents;
    }
    const hasCurrentAgent = agents.some((a) => a.name === data.agent?.name);
    if (hasCurrentAgent) {
      return agents;
    }
    return [
      { name: data.agent.name, headVersionId: null, updatedAt: "" },
      ...agents,
    ];
  })();

  const handleDisconnect = () => {
    detach(
      (async () => {
        await disconnect();
        closeConfirm();
        navigate("/settings", {
          searchParams: new URLSearchParams({ tab: "integrations" }),
        });
      })(),
      Reason.DomCallback,
    );
  };

  const handleAgentChange = (agentName: string) => {
    detach(updateAgent(agentName), Reason.DomCallback);
  };

  const breadcrumb = [
    { label: "Settings", path: "/settings" as const },
    "VM0 in Slack",
  ];

  return (
    <AppShell
      breadcrumb={breadcrumb}
      title="VM0 in Slack"
      subtitle="Configure your settings how to run VM0 in Slack Workspace."
    >
      <div className="flex flex-col gap-6 px-6 pb-8">
        {loading ? (
          <div className="flex flex-col gap-6">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : (
          <>
            <DefaultAgentSection
              isAdmin={data?.isAdmin ?? false}
              agentName={data?.agent?.name}
              agentOptions={agentOptions}
              onAgentChange={handleAgentChange}
            />

            <MissingEnvBanner
              missingSecrets={data?.environment.missingSecrets ?? []}
              missingVars={data?.environment.missingVars ?? []}
            />

            {/* Available commands section */}
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-base font-medium">
                  Your available commands
                </h3>
                <p className="text-sm text-muted-foreground">
                  This is commands you can directly interact with VM0 in Slack
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="font-mono text-sm leading-6">
                  <p>
                    <span className="font-medium">/vm0 connect</span>
                    <span className="text-muted-foreground">
                      {" // authenticate with VM0"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/vm0 disconnect</span>
                    <span className="text-muted-foreground">
                      {" // disconnect with VM0"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/vm0 settings</span>
                    <span className="text-muted-foreground">
                      {
                        " // open the VM0 platform and config your Slack settings"
                      }
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Disconnect section */}
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Disconnect with Slack</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-sm font-medium">Disconnect with Slack</p>
                  <p className="text-sm text-muted-foreground">
                    Your VM0 agent will be removed and disconnect with your
                    Slack workspace.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => openConfirm()}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeConfirm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Slack</DialogTitle>
            <DialogDescription>
              This will remove your Slack account connection and revoke agent
              access. You can reconnect at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => closeConfirm()}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
