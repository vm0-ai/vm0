import { useGet, useSet } from "ccstate-react";
import { IconAlertTriangle } from "@tabler/icons-react";
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
  githubIntegrationData$,
  githubIntegrationLoading$,
  disconnectGithub$,
  updateGithubDefaultAgent$,
  githubDisconnectDialogOpen$,
  openGithubDisconnectDialog$,
  closeGithubDisconnectDialog$,
} from "../../signals/integrations-page/github-integration.ts";
import { agentsList$ } from "../../signals/agents-page/agents-list.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { AppShell } from "../layout/app-shell.tsx";
import { Link } from "../router/link.tsx";

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
  agentName,
  missingSecrets,
  missingVars,
}: {
  agentName: string | undefined;
  missingSecrets: string[];
  missingVars: string[];
}) {
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
        {hasMissingConnectors &&
          (agentName ? (
            <Link
              pathname="/agents/:name/connections"
              options={{
                pathParams: { name: agentName },
                searchParams: new URLSearchParams({ tab: "connectors" }),
              }}
              className="font-medium text-amber-600 hover:underline dark:text-amber-500"
            >
              connectors
            </Link>
          ) : (
            <span className="font-medium text-amber-600 dark:text-amber-500">
              connectors
            </span>
          ))}
        {hasMissingConnectors && hasMissingSecretsOrVars && ", "}
        {hasMissingSecretsOrVars &&
          (agentName ? (
            <Link
              pathname="/agents/:name/connections"
              options={{
                pathParams: { name: agentName },
                searchParams: new URLSearchParams({ tab: "secrets" }),
              }}
              className="font-medium text-amber-600 hover:underline dark:text-amber-500"
            >
              secrets or variables
            </Link>
          ) : (
            <span className="font-medium text-amber-600 dark:text-amber-500">
              secrets or variables
            </span>
          ))}
        {". Add them now so it can run without stopping."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function GitHubSettingsPage() {
  const data = useGet(githubIntegrationData$);
  const loading = useGet(githubIntegrationLoading$);
  const agents = useGet(agentsList$);
  const navigate = useSet(navigateInReact$);
  const disconnect = useSet(disconnectGithub$);
  const updateAgent = useSet(updateGithubDefaultAgent$);
  const confirmOpen = useGet(githubDisconnectDialogOpen$);
  const openConfirm = useSet(openGithubDisconnectDialog$);
  const closeConfirm = useSet(closeGithubDisconnectDialog$);

  // Construct scoped agent name that matches the format used in agentsList$
  // (shared agents use "scope/name", owned agents use just "name").
  const scopedAgentName = (() => {
    if (!data?.agent) {
      return undefined;
    }
    const fullName = `${data.agent.scopeSlug}/${data.agent.name}`;
    // If the scoped name exists in agents list, use it (shared agent)
    if (agents.some((a) => a.name === fullName)) {
      return fullName;
    }
    // Otherwise use bare name (owned agent)
    return data.agent.name;
  })();

  // Ensure the current agent appears in the dropdown even if
  // it isn't in the user's own agents list (e.g. shared by another user).
  const agentOptions = (() => {
    if (!scopedAgentName) {
      return agents;
    }
    const hasCurrentAgent = agents.some((a) => a.name === scopedAgentName);
    if (hasCurrentAgent) {
      return agents;
    }
    return [
      { name: scopedAgentName, headVersionId: null, updatedAt: "" },
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
    "GitHub Issues",
  ];

  return (
    <AppShell
      breadcrumb={breadcrumb}
      title="GitHub Issues"
      subtitle="Configure your GitHub integration settings."
    >
      <div className="flex flex-col gap-6 px-6 pb-8">
        {loading ? (
          <div className="flex flex-col gap-6">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : (
          <>
            {/* Default agent section */}
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Default agent</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-sm font-medium">
                    Default agent for GitHub issues
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {
                      "If you want to manage your agent's model provider, secrets, or connectors, go to "
                    }
                    <Link
                      pathname="/settings"
                      options={{
                        searchParams: new URLSearchParams({ tab: "providers" }),
                      }}
                      className="text-primary hover:underline"
                    >
                      Settings
                    </Link>
                    .
                  </p>
                </div>
                <Select
                  value={scopedAgentName ?? ""}
                  onValueChange={handleAgentChange}
                >
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
              </div>
            </div>

            <MissingEnvBanner
              agentName={scopedAgentName}
              missingSecrets={data?.environment.missingSecrets ?? []}
              missingVars={data?.environment.missingVars ?? []}
            />

            {/* Disconnect section */}
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Disconnect GitHub</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-sm font-medium">
                    Disconnect GitHub integration
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Your GitHub App installation will be removed and agents will
                    no longer respond to GitHub issues.
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
            <DialogTitle>Disconnect GitHub</DialogTitle>
            <DialogDescription>
              This will remove your GitHub App installation and delete all
              associated issue sessions. You can reconnect at any time.
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
