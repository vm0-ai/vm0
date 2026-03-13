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
import { Link } from "../router/link.tsx";

function getAllConnectorEnvVars(): Set<string> {
  return getConnectorProvidedSecretNames(
    Object.keys(CONNECTOR_TYPES) as ConnectorType[],
  );
}

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
        {hasMissingConnectors && agentName && (
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
        )}
        {hasMissingConnectors && hasMissingSecretsOrVars && ", "}
        {hasMissingSecretsOrVars && agentName && (
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
        )}
        {". Add them now so it can run without stopping."}
      </p>
    </div>
  );
}

/** Slack config content for Zero app only (Where Zero works → Configure dialog). Uses same signals as platform but lives under zero-page so platform is untouched. */
export function ZeroSlackConfigContent({
  onAfterDisconnect,
}: {
  onAfterDisconnect?: () => void;
} = {}) {
  const data = useGet(slackIntegrationData$);
  const loading = useGet(slackIntegrationLoading$);
  const agents = useGet(agentsList$);
  const navigate = useSet(navigateInReact$);
  const disconnect = useSet(disconnectSlack$);
  const updateAgent = useSet(updateSlackDefaultAgent$);
  const confirmOpen = useGet(slackDisconnectDialogOpen$);
  const openConfirm = useSet(openSlackDisconnectDialog$);
  const closeConfirm = useSet(closeSlackDisconnectDialog$);

  const qualifiedAgentName = (() => {
    if (!data?.agent) {
      return undefined;
    }
    const fullName = `${data.agent.scopeSlug}/${data.agent.name}`;
    if (agents.some((a) => a.name === fullName)) {
      return fullName;
    }
    return data.agent.name;
  })();

  const agentOptions = (() => {
    if (!qualifiedAgentName) {
      return agents;
    }
    const hasCurrentAgent = agents.some((a) => a.name === qualifiedAgentName);
    if (hasCurrentAgent) {
      return agents;
    }
    return [
      { name: qualifiedAgentName, headVersionId: null, updatedAt: "" },
      ...agents,
    ];
  })();

  const handleDisconnect = () => {
    detach(
      (async () => {
        await disconnect();
        closeConfirm();
        if (onAfterDisconnect) {
          onAfterDisconnect();
        } else {
          navigate("/settings", {
            searchParams: new URLSearchParams({ tab: "integrations" }),
          });
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleAgentChange = (agentName: string) => {
    detach(updateAgent(agentName), Reason.DomCallback);
  };

  return (
    <>
      <div className="flex flex-col gap-6">
        {loading ? (
          <div className="flex flex-col gap-6">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Default agent</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <div className="flex flex-1 flex-col gap-1">
                  {data?.isAdmin ? (
                    <p className="text-sm text-muted-foreground">
                      <Link
                        pathname="/settings"
                        options={{
                          searchParams: new URLSearchParams({
                            tab: "providers",
                          }),
                        }}
                        className="text-primary hover:underline"
                      >
                        Settings
                      </Link>{" "}
                      for model, secrets, and connectors.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Managed by your workspace admin. Contact them to change
                      it.
                    </p>
                  )}
                </div>
                {data?.isAdmin ? (
                  <Select
                    value={qualifiedAgentName ?? ""}
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
                ) : (
                  <div className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 sm:w-[280px] sm:shrink-0">
                    <span className="truncate text-sm">
                      {qualifiedAgentName ?? "No agent"}
                    </span>
                    <IconChevronDown
                      size={16}
                      className="shrink-0 opacity-50"
                    />
                  </div>
                )}
              </div>
            </div>

            <MissingEnvBanner
              agentName={qualifiedAgentName}
              missingSecrets={data?.environment.missingSecrets ?? []}
              missingVars={data?.environment.missingVars ?? []}
            />

            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Your available commands</h3>
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="font-mono text-sm leading-6">
                  <p>
                    <span className="font-medium">/vm0 connect</span>
                    <span className="text-muted-foreground">
                      {" // authenticate"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/vm0 disconnect</span>
                    <span className="text-muted-foreground">
                      {" // disconnect"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/vm0 settings</span>
                    <span className="text-muted-foreground">
                      {" // open config"}
                    </span>
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Uninstall Slack</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <p className="flex-1 text-sm text-muted-foreground">
                  Remove the agent from your Slack workspace.
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => openConfirm()}
                >
                  Uninstall
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
            <DialogTitle>Uninstall Slack</DialogTitle>
            <DialogDescription>
              You can reinstall at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => closeConfirm()}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDisconnect}>
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
