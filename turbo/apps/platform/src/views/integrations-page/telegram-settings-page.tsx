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
  telegramIntegrationData$,
  telegramIntegrationLoading$,
  disconnectTelegram$,
  updateTelegramDefaultAgent$,
  telegramDisconnectDialogOpen$,
  openTelegramDisconnectDialog$,
  closeTelegramDisconnectDialog$,
} from "../../signals/integrations-page/telegram-integration.ts";
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
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-medium">Default agent</h3>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 flex-col gap-1">
          {isAdmin ? (
            <p className="text-sm font-medium">
              Default agent you would like to use in Telegram
            </p>
          ) : (
            <>
              <p className="text-sm font-medium">
                Default agent you use in Telegram
              </p>
              <p className="text-sm text-muted-foreground">
                This agent is managed by the bot admin. To make changes, please
                contact the bot admin.
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

export function TelegramSettingsPage() {
  const data = useGet(telegramIntegrationData$);
  const loading = useGet(telegramIntegrationLoading$);
  const agents = useGet(agentsList$);
  const navigate = useSet(navigateInReact$);
  const disconnect = useSet(disconnectTelegram$);
  const updateAgent = useSet(updateTelegramDefaultAgent$);
  const confirmOpen = useGet(telegramDisconnectDialogOpen$);
  const openConfirm = useSet(openTelegramDisconnectDialog$);
  const closeConfirm = useSet(closeTelegramDisconnectDialog$);

  // Construct scoped agent name that matches the format used in agentsList$
  const scopedAgentName = (() => {
    if (!data?.agent) {
      return undefined;
    }
    const fullName = `${data.agent.scopeSlug}/${data.agent.name}`;
    if (agents.some((a) => a.name === fullName)) {
      return fullName;
    }
    return data.agent.name;
  })();

  // Ensure the current agent appears in the dropdown
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
    "VM0 in Telegram",
  ];

  return (
    <AppShell
      breadcrumb={breadcrumb}
      title="VM0 in Telegram"
      subtitle="Configure your settings for running VM0 in Telegram."
      contentClassName="mx-auto w-full max-w-[1200px]"
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
            {/* Link account banner */}
            {/* Bot info */}
            {data?.bot && (
              <div className="flex flex-col gap-4">
                <h3 className="text-base font-medium">Bot info</h3>
                <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-muted-foreground">
                      Username:
                    </span>
                    <span>@{data.bot.username}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-muted-foreground">
                      Bot ID:
                    </span>
                    <span>{data.bot.id}</span>
                  </div>
                </div>
              </div>
            )}

            <DefaultAgentSection
              isAdmin={data?.isAdmin ?? false}
              agentName={scopedAgentName}
              agentOptions={agentOptions}
              onAgentChange={handleAgentChange}
            />

            <MissingEnvBanner
              agentName={scopedAgentName}
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
                  Commands you can use directly with the bot in Telegram
                </p>
              </div>
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="font-mono text-sm leading-6">
                  <p>
                    <span className="font-medium">/new_session</span>
                    <span className="text-muted-foreground">
                      {" // start a new conversation"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/connect</span>
                    <span className="text-muted-foreground">
                      {" // connect your VM0 account"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/disconnect</span>
                    <span className="text-muted-foreground">
                      {" // disconnect your account"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/settings</span>
                    <span className="text-muted-foreground">
                      {" // open platform settings"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">/help</span>
                    <span className="text-muted-foreground">
                      {" // show available commands"}
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Disconnect section */}
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-medium">Uninstall Telegram</h3>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-sm font-medium">Uninstall bot</p>
                  <p className="text-sm text-muted-foreground">
                    Your VM0 agent will be uninstalled from this Telegram bot.
                    All linked accounts and message history will be removed.
                  </p>
                </div>
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
            <DialogTitle>Uninstall Telegram</DialogTitle>
            <DialogDescription>
              This will remove the Telegram bot installation, delete all linked
              accounts, and clear message history. You can reinstall at any
              time.
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
    </AppShell>
  );
}
