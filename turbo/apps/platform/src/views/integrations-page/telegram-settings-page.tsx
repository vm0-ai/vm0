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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { detach, Reason } from "../../signals/utils.ts";
import {
  telegramIntegrationData$,
  telegramIntegrationLoading$,
  telegramIntegrationIsConnected$,
  disconnectTelegramAccount$,
  disconnectTelegram$,
  updateTelegramDefaultAgent$,
  telegramDisconnectDialogOpen$,
  openTelegramDisconnectDialog$,
  closeTelegramDisconnectDialog$,
  openTelegramLoginPopup$,
} from "../../signals/integrations-page/telegram-integration.ts";
import { copyStatus$, copyToClipboard$ } from "../../signals/onboarding.ts";
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
// Connect / Disconnect account section
// ---------------------------------------------------------------------------

function ConnectAccountSection({
  isConnected,
  domainConfigured,
  botId,
  copyStatus,
  onDisconnect,
  onConnect,
  onCopyDomain,
}: {
  isConnected: boolean;
  domainConfigured: boolean;
  botId: string | undefined;
  copyStatus: string;
  onDisconnect: () => void;
  onConnect: (botId: string) => void;
  onCopyDomain: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-medium">
        {isConnected ? "Disconnect account" : "Connect account"}
      </h3>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
        {isConnected ? (
          <>
            <div className="flex flex-1 flex-col gap-1">
              <p className="text-sm font-medium">
                Disconnect your Telegram account
              </p>
              <p className="text-sm text-muted-foreground">
                Unlink your Telegram account from VM0. The bot installation will
                remain active for other users.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onDisconnect}>
              Disconnect
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-1 flex-col gap-1">
              <p className="text-sm font-medium">
                Connect your Telegram account
              </p>
              <p className="text-sm text-muted-foreground">
                {domainConfigured
                  ? "Link your Telegram account to VM0."
                  : "Link your Telegram account to VM0. You can also use /connect in Telegram."}
              </p>
              {!domainConfigured && (
                <p className="text-sm text-amber-600 dark:text-amber-500">
                  {"Run /setdomain in "}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                  >
                    @BotFather
                  </a>
                  {" and set domain to "}
                  <code
                    className="cursor-pointer rounded border border-amber-300 bg-amber-50 px-1 py-0.5 font-mono text-xs hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
                    onClick={onCopyDomain}
                    title="Click to copy"
                  >
                    {copyStatus === "copied"
                      ? "Copied!"
                      : window.location.hostname}
                  </code>
                  {" to enable web login."}
                </p>
              )}
            </div>
            {botId && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="sm:shrink-0">
                      <Button
                        size="sm"
                        disabled={!domainConfigured}
                        onClick={() => onConnect(botId)}
                      >
                        Connect
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!domainConfigured && (
                    <TooltipContent>
                      Telegram requires a verified domain for web login. Run
                      /setdomain in @BotFather first, or use /connect in
                      Telegram.
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            )}
          </>
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
  const isConnected = useGet(telegramIntegrationIsConnected$);
  const agents = useGet(agentsList$);
  const navigate = useSet(navigateInReact$);
  const disconnectAccount = useSet(disconnectTelegramAccount$);
  const uninstall = useSet(disconnectTelegram$);
  const updateAgent = useSet(updateTelegramDefaultAgent$);
  const confirmOpen = useGet(telegramDisconnectDialogOpen$);
  const openConfirm = useSet(openTelegramDisconnectDialog$);
  const closeConfirm = useSet(closeTelegramDisconnectDialog$);
  const copyStatus = useGet(copyStatus$);
  const copyToClipboard = useSet(copyToClipboard$);
  const openPopup = useSet(openTelegramLoginPopup$);

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

  const handleDisconnectAccount = () => {
    detach(disconnectAccount(), Reason.DomCallback);
  };

  const handleUninstall = () => {
    detach(
      (async () => {
        await uninstall();
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

            <ConnectAccountSection
              isConnected={isConnected}
              domainConfigured={data?.domainConfigured ?? false}
              botId={data?.bot?.id}
              copyStatus={copyStatus}
              onDisconnect={handleDisconnectAccount}
              onConnect={(botId) => openPopup(botId)}
              onCopyDomain={() => {
                detach(
                  copyToClipboard(window.location.hostname),
                  Reason.DomCallback,
                );
              }}
            />

            {/* Uninstall bot (admin only) */}
            {data?.isAdmin && (
              <div className="flex flex-col gap-4">
                <h3 className="text-base font-medium">Uninstall Telegram</h3>
                <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                  <div className="flex flex-1 flex-col gap-1">
                    <p className="text-sm font-medium">Uninstall bot</p>
                    <p className="text-sm text-muted-foreground">
                      Remove the Telegram bot installation. All linked accounts
                      and message history will be deleted.
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
            )}
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
            <Button variant="destructive" onClick={handleUninstall}>
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
