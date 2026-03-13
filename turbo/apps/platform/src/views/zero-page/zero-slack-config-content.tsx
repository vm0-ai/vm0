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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { detach, Reason } from "../../signals/utils.ts";
import {
  slackOrgData$,
  slackOrgLoading$,
  disconnectSlackOrg$,
  slackOrgDisconnectDialogOpen$,
  openSlackOrgDisconnectDialog$,
  closeSlackOrgDisconnectDialog$,
} from "../../signals/zero-page/zero-slack.ts";
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

/** Slack config content for Zero app — org-aware integration. Agent is managed via org default, not changeable here. */
export function ZeroSlackConfigContent({
  onAfterDisconnect,
}: {
  onAfterDisconnect?: () => void;
} = {}) {
  const data = useGet(slackOrgData$);
  const loading = useGet(slackOrgLoading$);
  const disconnect = useSet(disconnectSlackOrg$);
  const confirmOpen = useGet(slackOrgDisconnectDialogOpen$);
  const openConfirm = useSet(openSlackOrgDisconnectDialog$);
  const closeConfirm = useSet(closeSlackOrgDisconnectDialog$);

  const qualifiedAgentName = (() => {
    if (!data?.defaultAgentName) {
      return undefined;
    }
    if (data.agentOrgSlug) {
      return `${data.agentOrgSlug}/${data.defaultAgentName}`;
    }
    return data.defaultAgentName;
  })();

  const handleDisconnect = () => {
    detach(
      (async () => {
        await disconnect();
        closeConfirm();
        onAfterDisconnect?.();
      })(),
      Reason.DomCallback,
    );
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
                  <p className="text-sm text-muted-foreground">
                    Managed by your org default agent setting.
                    {data?.isAdmin && (
                      <>
                        {" "}
                        Change it in{" "}
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
                        </Link>
                        .
                      </>
                    )}
                  </p>
                </div>
                <div className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 sm:w-[280px] sm:shrink-0">
                  <span className="truncate text-sm">
                    {qualifiedAgentName ?? "No agent"}
                  </span>
                </div>
              </div>
            </div>

            <MissingEnvBanner
              agentName={qualifiedAgentName}
              missingSecrets={data?.environment?.missingSecrets ?? []}
              missingVars={data?.environment?.missingVars ?? []}
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
              <h3 className="text-base font-medium">Disconnect Slack</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <p className="flex-1 text-sm text-muted-foreground">
                  Disconnect your account from this Slack workspace.
                </p>
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
              You can reconnect at any time using /vm0 connect in Slack.
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
    </>
  );
}
