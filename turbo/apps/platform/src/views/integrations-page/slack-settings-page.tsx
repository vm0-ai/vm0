import { useGet, useSet } from "ccstate-react";
import { IconChevronDown, IconMovie } from "@tabler/icons-react";
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

  const handleFillSecrets = () => {
    const params = new URLSearchParams();
    if (data?.environment.missingSecrets.length) {
      params.set("secrets", data.environment.missingSecrets.join(","));
    }
    if (data?.environment.missingVars.length) {
      params.set("vars", data.environment.missingVars.join(","));
    }
    window.open(
      `${window.location.origin}/environment-variables-setup?${params.toString()}`,
      "_blank",
    );
  };

  const hasMissingEnv =
    (data?.environment.missingSecrets.length ?? 0) > 0 ||
    (data?.environment.missingVars.length ?? 0) > 0;

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
            {/* Default agent section */}
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Default agent</h3>
              <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-1 flex-col gap-1">
                  {data?.isAdmin ? (
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
                        This agent is managed by your Slack workspace admin. To
                        make changes, please contact your workspace admin.
                      </p>
                    </>
                  )}
                </div>
                {data?.isAdmin ? (
                  <Select
                    value={data?.agent?.name ?? ""}
                    onValueChange={handleAgentChange}
                  >
                    <SelectTrigger className="w-[280px] shrink-0">
                      <SelectValue placeholder="Select an agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.name} value={agent.name}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex h-9 w-[280px] shrink-0 items-center justify-between rounded-lg border border-border bg-muted px-3 py-2">
                    <span className="truncate text-sm">
                      {data?.agent?.name ?? "No agent"}
                    </span>
                    <IconChevronDown
                      size={16}
                      className="shrink-0 opacity-50"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Info banner for missing secrets */}
            {hasMissingEnv && (
              <div className="flex items-center gap-3 rounded-lg border border-sky-500 bg-sky-50 px-4 py-3 dark:border-sky-800 dark:bg-sky-950/30">
                <IconMovie
                  size={24}
                  className="shrink-0 text-sky-500"
                  stroke={1.5}
                />
                <p className="flex-1 text-sm font-medium">
                  {data?.isAdmin
                    ? "This agent may be missing required secrets or variables. To avoid interruptions, please fill in the missing values."
                    : "This agent is shared and managed by your Slack workspace admin. To use it without interruption, fill the necessary secrets and connectors."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-white text-sky-600 border-sky-600 hover:bg-sky-50 dark:bg-background"
                  onClick={handleFillSecrets}
                >
                  Fill
                </Button>
              </div>
            )}

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
              <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
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
