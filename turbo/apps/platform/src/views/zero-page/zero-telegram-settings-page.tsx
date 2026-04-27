import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDotsVertical,
  IconKey,
  IconLoader2,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import type { TelegramBot } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  disconnectTelegramAccount$,
  registerTelegramBot$,
  reinstallTelegramBot$,
  setTelegramReinstallDialogBotId$,
  setTelegramReinstallingBotId$,
  setTelegramReinstallTokenForm$,
  setTelegramBotAgentForm$,
  setTelegramBotTokenForm$,
  setTelegramSavingBotId$,
  setTelegramUninstallDialogBotId$,
  setTelegramUninstallingBotId$,
  setTelegramUnlinkingBotId$,
  telegramBotAgentForm$,
  telegramBots$,
  telegramBotTokenForm$,
  telegramReinstallDialogBotId$,
  telegramReinstallingBotId$,
  telegramReinstallTokenForm$,
  telegramSavingBotId$,
  telegramUninstallDialogBotId$,
  telegramUninstallingBotId$,
  telegramUnlinkingBotId$,
  uninstallTelegramBot$,
  updateTelegramBotAgent$,
} from "../../signals/zero-page/zero-telegram.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import telegramIconImg from "./components/settings/icons/telegram.svg";

interface DefaultAgentLabel {
  id: string | null;
  displayName: string | null;
}

function agentLabel(
  agent: TeamComposeItem | { id: string; name: string },
  defaultAgent: DefaultAgentLabel,
) {
  if (agent.id === defaultAgent.id && defaultAgent.displayName) {
    return defaultAgent.displayName;
  }

  if ("displayName" in agent) {
    return agent.displayName ?? agent.id;
  }
  return agent.name || agent.id;
}

function buildBotAgentOptions(
  bot: TelegramBot,
  agents: TeamComposeItem[],
  defaultAgent: DefaultAgentLabel,
) {
  if (
    !bot.agent ||
    agents.some((agent) => {
      return agent.id === bot.agent?.id;
    })
  ) {
    return agents;
  }

  return [
    ...agents,
    {
      id: bot.agent.id,
      displayName:
        bot.agent.id === defaultAgent.id && defaultAgent.displayName
          ? defaultAgent.displayName
          : bot.agent.name,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: null,
      updatedAt: "",
    },
  ];
}

function botRouteLabel(
  bot: TelegramBot,
  agents: TeamComposeItem[],
  defaultAgent: DefaultAgentLabel,
) {
  if (!bot.agent) {
    return "No default agent";
  }
  const agent = agents.find((item) => {
    return item.id === bot.agent?.id;
  });
  return `Routes to ${agent ? agentLabel(agent, defaultAgent) : agentLabel(bot.agent, defaultAgent)}`;
}

function TelegramSettingsSkeleton() {
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="telegram-settings-loading"
    >
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function TelegramStatusBadge({ bot }: { bot: TelegramBot }) {
  if (bot.tokenStatus === "invalid") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
        <IconAlertTriangle className="h-3.5 w-3.5" />
        Token invalid
      </span>
    );
  }

  const connected = bot.isConnected;
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-secondary-foreground">
        <IconCircleCheck className="h-3.5 w-3.5 text-green-600" />
        Connected
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
      <IconAlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      Not connected
    </span>
  );
}

function AddTelegramBotForm({
  agents,
  defaultAgent,
  disabled,
}: {
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
}) {
  const botToken = useGet(telegramBotTokenForm$);
  const selectedAgentId = useGet(telegramBotAgentForm$);
  const preferredAgentId = selectedAgentId ?? defaultAgent.id ?? agents[0]?.id;
  const selectedAgent =
    agents.find((agent) => {
      return agent.id === preferredAgentId;
    }) ?? agents[0];
  const agentId = selectedAgent?.id;
  const selectedAgentLabel = selectedAgent
    ? agentLabel(selectedAgent, defaultAgent)
    : (defaultAgent.displayName ?? "Select agent");
  const setBotToken = useSet(setTelegramBotTokenForm$);
  const setAgentId = useSet(setTelegramBotAgentForm$);
  const navigate = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);
  const [registerLoadable, registerBot] = useLoadableSet(registerTelegramBot$);
  const adding = registerLoadable.state === "loading";
  const canSubmit = botToken.trim().length > 0 && !disabled && !adding;

  return (
    <form
      className="zero-card p-4 sm:p-5"
      aria-label="Add Telegram bot"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) {
          return;
        }

        detach(
          registerBot(
            {
              botToken: botToken.trim(),
              ...(agentId ? { defaultAgentId: agentId } : {}),
            },
            pageSignal,
          ).then((bot) => {
            setBotToken("");
            setAgentId(null);
            navigate(ROUTES.telegramConnect, {
              searchParams: new URLSearchParams({ bot: bot.id }),
            });
          }),
          Reason.DomCallback,
        );
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="telegram-bot-token"
            className="mb-2 block text-sm font-medium text-foreground"
          >
            Bot token
          </label>
          <Input
            id="telegram-bot-token"
            type="password"
            value={botToken}
            disabled={disabled || adding}
            autoComplete="off"
            placeholder="123456:ABC-DEF"
            onChange={(event) => {
              setBotToken(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 sm:w-64">
          <label
            htmlFor="telegram-new-bot-agent"
            className="mb-2 block text-sm font-medium text-foreground"
          >
            Default agent
          </label>
          <Select
            value={agentId ?? ""}
            disabled={disabled || adding || agents.length === 0}
            onValueChange={(value) => {
              setAgentId(value);
            }}
          >
            <SelectTrigger id="telegram-new-bot-agent">
              <SelectValue placeholder={selectedAgentLabel} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => {
                return (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agentLabel(agent, defaultAgent)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="submit"
          disabled={!canSubmit}
          className="h-10 shrink-0 gap-2"
        >
          {adding ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : (
            <IconPlus size={16} />
          )}
          {adding ? "Adding..." : "Add bot"}
        </Button>
      </div>
    </form>
  );
}

function TelegramBotAgentSelect({
  bot,
  options,
  defaultAgent,
  disabled,
}: {
  bot: TelegramBot;
  options: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
}) {
  const setSavingBotId = useSet(setTelegramSavingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, updateBotAgent] = useLoadableSet(updateTelegramBotAgent$);

  return (
    <Select
      value={bot.agent?.id ?? ""}
      disabled={disabled || options.length === 0}
      onValueChange={(nextAgentId) => {
        if (nextAgentId === bot.agent?.id) {
          return;
        }
        setSavingBotId(bot.id);
        detach(
          updateBotAgent(
            { botId: bot.id, defaultAgentId: nextAgentId },
            pageSignal,
          ).finally(() => {
            setSavingBotId(null);
          }),
          Reason.DomCallback,
        );
      }}
    >
      <SelectTrigger
        aria-label={`Default agent for ${bot.username ?? bot.id}`}
        className="h-9"
      >
        <SelectValue placeholder="Select agent" />
      </SelectTrigger>
      <SelectContent>
        {options.map((agent) => {
          return (
            <SelectItem key={agent.id} value={agent.id}>
              {agentLabel(agent, defaultAgent)}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function TelegramBotActions({
  bot,
  canManage,
  disabled,
  unlinking,
  uninstalling,
  reinstalling,
}: {
  bot: TelegramBot;
  canManage: boolean;
  disabled: boolean;
  unlinking: boolean;
  uninstalling: boolean;
  reinstalling: boolean;
}) {
  const setUnlinkingBotId = useSet(setTelegramUnlinkingBotId$);
  const setUninstallDialogBotId = useSet(setTelegramUninstallDialogBotId$);
  const setReinstallDialogBotId = useSet(setTelegramReinstallDialogBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, disconnectAccount] = useLoadableSet(disconnectTelegramAccount$);
  const botLabel = bot.username ? `@${bot.username}` : "Telegram bot";
  const showMore = bot.isConnected || (canManage && !bot.isConnected);
  const tokenInvalid = bot.tokenStatus === "invalid";

  return (
    <div className="flex items-center justify-end gap-1.5">
      {canManage && tokenInvalid ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || reinstalling}
          className="h-9 justify-center gap-2"
          onClick={() => {
            setReinstallDialogBotId(bot.id);
          }}
        >
          {reinstalling ? (
            <IconLoader2 size={15} className="animate-spin" />
          ) : (
            <IconRefresh size={15} />
          )}
          {reinstalling ? "Reinstalling..." : "Reinstall"}
        </Button>
      ) : null}
      {!bot.isConnected ? (
        disabled || tokenInvalid ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            className="h-9 justify-center"
          >
            Connect
          </Button>
        ) : (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-9 justify-center"
          >
            <Link
              pathname={ROUTES.telegramConnect}
              options={{
                searchParams: new URLSearchParams({ bot: bot.id }),
              }}
            >
              Connect
            </Link>
          </Button>
        )
      ) : null}
      {showMore ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="shrink-0 rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
              aria-label={`More options for ${botLabel}`}
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex w-40 flex-col gap-0.5 p-2"
          >
            {bot.isConnected ? (
              <button
                type="button"
                aria-label={`Disconnect ${botLabel}`}
                disabled={unlinking}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  setUnlinkingBotId(bot.id);
                  detach(
                    disconnectAccount(bot.id, pageSignal).finally(() => {
                      setUnlinkingBotId(null);
                    }),
                    Reason.DomCallback,
                  );
                }}
              >
                {unlinking ? "Disconnecting..." : "Disconnect"}
              </button>
            ) : null}
            {canManage && !bot.isConnected ? (
              <button
                type="button"
                aria-label={`Uninstall ${botLabel}`}
                disabled={uninstalling}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  setUninstallDialogBotId(bot.id);
                }}
              >
                {uninstalling ? "Uninstalling..." : "Uninstall"}
              </button>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function TelegramBotRow({
  bot,
  agents,
  defaultAgent,
  canManage,
  disabled,
}: {
  bot: TelegramBot;
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  canManage: boolean;
  disabled: boolean;
}) {
  const savingBotId = useGet(telegramSavingBotId$);
  const unlinkingBotId = useGet(telegramUnlinkingBotId$);
  const uninstallingBotId = useGet(telegramUninstallingBotId$);
  const reinstallingBotId = useGet(telegramReinstallingBotId$);
  const saving = savingBotId === bot.id;
  const unlinking = unlinkingBotId === bot.id;
  const uninstalling = uninstallingBotId === bot.id;
  const reinstalling = reinstallingBotId === bot.id;
  const actionDisabled =
    disabled || saving || unlinking || uninstalling || reinstalling;
  const options = buildBotAgentOptions(bot, agents, defaultAgent);
  const routeLabel = botRouteLabel(bot, agents, defaultAgent);

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#2AABEE]/10">
          <img src={telegramIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">
              {bot.username ? `@${bot.username}` : "Telegram bot"}
            </div>
            <TelegramStatusBadge bot={bot} />
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground">
            {routeLabel}
          </div>
          {bot.tokenStatus === "invalid" ? (
            <div className="mt-1 text-sm text-muted-foreground">
              Reinstall the bot with a fresh token from BotFather.
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={
          canManage
            ? "grid gap-2 sm:w-[360px] sm:grid-cols-[1fr_auto]"
            : "flex justify-end"
        }
      >
        {canManage ? (
          <TelegramBotAgentSelect
            bot={bot}
            options={options}
            defaultAgent={defaultAgent}
            disabled={actionDisabled}
          />
        ) : null}
        <TelegramBotActions
          bot={bot}
          canManage={canManage}
          disabled={actionDisabled}
          unlinking={unlinking}
          uninstalling={uninstalling}
          reinstalling={reinstalling}
        />
        {canManage && saving ? (
          <div className="text-xs text-muted-foreground sm:col-span-2">
            Saving agent...
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TelegramReinstallDialog({ bot }: { bot: TelegramBot | null }) {
  const token = useGet(telegramReinstallTokenForm$);
  const reinstallingBotId = useGet(telegramReinstallingBotId$);
  const setToken = useSet(setTelegramReinstallTokenForm$);
  const setReinstallDialogBotId = useSet(setTelegramReinstallDialogBotId$);
  const setReinstallingBotId = useSet(setTelegramReinstallingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, reinstallBot] = useLoadableSet(reinstallTelegramBot$);
  const reinstalling = !!bot && reinstallingBotId === bot.id;
  const canSubmit = !!bot && token.trim().length > 0 && !reinstalling;
  const botLabel = bot?.username ? `@${bot.username}` : "this bot";

  return (
    <Dialog
      open={!!bot}
      onOpenChange={(open) => {
        if (!open && !reinstalling) {
          setReinstallDialogBotId(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reinstall Telegram bot</DialogTitle>
          <DialogDescription>
            Paste the fresh BotFather token for {botLabel}. The token must
            belong to this same bot.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!bot || !canSubmit) {
              return;
            }
            setReinstallingBotId(bot.id);
            detach(
              reinstallBot(
                { botId: bot.id, botToken: token.trim() },
                pageSignal,
              )
                .then(() => {
                  setReinstallDialogBotId(null);
                })
                .finally(() => {
                  setReinstallingBotId(null);
                }),
              Reason.DomCallback,
            );
          }}
        >
          <div>
            <label
              htmlFor="telegram-reinstall-token"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              New bot token
            </label>
            <div className="relative">
              <IconKey
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="telegram-reinstall-token"
                type="password"
                value={token}
                disabled={reinstalling}
                autoComplete="off"
                placeholder="123456:ABC-DEF"
                className="pl-9"
                onChange={(event) => {
                  setToken(event.target.value);
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={reinstalling}
              onClick={() => {
                setReinstallDialogBotId(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} className="gap-2">
              {reinstalling ? (
                <IconLoader2 size={16} className="animate-spin" />
              ) : (
                <IconRefresh size={16} />
              )}
              {reinstalling ? "Reinstalling..." : "Reinstall"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TelegramUninstallDialog({ bot }: { bot: TelegramBot | null }) {
  const setUninstallDialogBotId = useSet(setTelegramUninstallDialogBotId$);
  const setUninstallingBotId = useSet(setTelegramUninstallingBotId$);
  const uninstallingBotId = useGet(telegramUninstallingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, uninstallBot] = useLoadableSet(uninstallTelegramBot$);
  const uninstalling = !!bot && uninstallingBotId === bot.id;

  return (
    <Dialog
      open={!!bot}
      onOpenChange={(open) => {
        if (!open && !uninstalling) {
          setUninstallDialogBotId(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Uninstall Telegram bot?</DialogTitle>
          <DialogDescription>
            This removes {bot?.username ? `@${bot.username}` : "this bot"} from
            the workspace and disconnects Telegram access for users who use it.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={uninstalling}
            onClick={() => {
              setUninstallDialogBotId(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!bot || uninstalling}
            onClick={() => {
              if (!bot) {
                return;
              }
              setUninstallingBotId(bot.id);
              detach(
                uninstallBot(bot.id, pageSignal)
                  .then(() => {
                    setUninstallDialogBotId(null);
                  })
                  .finally(() => {
                    setUninstallingBotId(null);
                  }),
                Reason.DomCallback,
              );
            }}
          >
            {uninstalling ? "Uninstalling..." : "Uninstall"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TelegramBotList({
  bots,
  agents,
  defaultAgent,
  isAdmin,
  agentsLoading,
}: {
  bots: TelegramBot[];
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  isAdmin: boolean;
  agentsLoading: boolean;
}) {
  if (bots.length === 0) {
    return (
      <div className="zero-card px-6 py-12 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
          <img src={telegramIconImg} alt="" className="h-8 w-8" />
        </div>
        <div className="text-sm font-medium text-foreground">
          No Telegram bots yet
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          Add a bot token to start routing Telegram messages to an agent.
        </div>
      </div>
    );
  }

  return (
    <div className="zero-card overflow-hidden">
      {bots.map((bot, index) => {
        return (
          <div key={bot.id}>
            <TelegramBotRow
              bot={bot}
              agents={agents}
              defaultAgent={defaultAgent}
              canManage={bot.isOwner || isAdmin}
              disabled={agentsLoading}
            />
            {index < bots.length - 1 ? (
              <div className="mx-5 border-b border-border/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ZeroTelegramSettingsPage() {
  const botsLoadable = useLastLoadable(telegramBots$);
  const agentsLoadable = useLastLoadable(sortedAgents$);
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const bots = botsLoadable.state === "hasData" ? botsLoadable.data : [];
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const defaultAgent: DefaultAgentLabel = {
    id:
      defaultAgentIdLoadable.state === "hasData"
        ? defaultAgentIdLoadable.data
        : (agents[0]?.id ?? null),
    displayName:
      defaultAgentNameLoadable.state === "hasData"
        ? defaultAgentNameLoadable.data
        : null,
  };
  const uninstallDialogBotId = useGet(telegramUninstallDialogBotId$);
  const reinstallDialogBotId = useGet(telegramReinstallDialogBotId$);
  const uninstallBot =
    bots.find((bot) => {
      return bot.id === uninstallDialogBotId;
    }) ?? null;
  const reinstallBot =
    bots.find((bot) => {
      return bot.id === reinstallDialogBotId;
    }) ?? null;
  const loading =
    botsLoadable.state === "loading" &&
    bots.length === 0 &&
    agents.length === 0;
  const hasError =
    botsLoadable.state === "hasError" || agentsLoadable.state === "hasError";
  const agentsLoading = agentsLoadable.state === "loading";

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
                  <img src={telegramIconImg} alt="" className="h-7 w-7" />
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    Telegram
                  </h1>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Manage bot routing for this workspace
                  </p>
                </div>
              </div>
            </div>
            <span
              data-testid="telegram-bot-count"
              className="inline-flex w-fit items-center rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
            >
              {bots.length} {bots.length === 1 ? "bot" : "bots"}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {hasError ? (
            <div className="zero-card px-6 py-10 text-center text-sm text-destructive">
              Couldn&apos;t load Telegram settings.
            </div>
          ) : loading ? (
            <TelegramSettingsSkeleton />
          ) : (
            <>
              <AddTelegramBotForm
                agents={agents}
                defaultAgent={defaultAgent}
                disabled={agentsLoading}
              />
              <TelegramBotList
                bots={bots}
                agents={agents}
                defaultAgent={defaultAgent}
                isAdmin={isAdmin}
                agentsLoading={agentsLoading}
              />
              <TelegramUninstallDialog bot={uninstallBot} />
              <TelegramReinstallDialog bot={reinstallBot} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
