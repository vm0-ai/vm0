import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconLoader2,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { TelegramBot } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { sortedAgents$ } from "../../signals/agent.ts";
import {
  disconnectTelegramBot$,
  registerTelegramBot$,
  setTelegramBotAgentForm$,
  setTelegramBotTokenForm$,
  setTelegramDisconnectingBotId$,
  setTelegramSavingBotId$,
  telegramBotAgentForm$,
  telegramBots$,
  telegramBotTokenForm$,
  telegramDisconnectingBotId$,
  telegramSavingBotId$,
  updateTelegramBotAgent$,
} from "../../signals/zero-page/zero-telegram.ts";
import { detach, Reason } from "../../signals/utils.ts";
import telegramIconImg from "./components/settings/icons/telegram.svg";

const DEFAULT_AGENT_VALUE = "__default_agent__";

function agentLabel(agent: TeamComposeItem | { id: string; name: string }) {
  if ("displayName" in agent) {
    return agent.displayName ?? agent.id;
  }
  return agent.name || agent.id;
}

function buildBotAgentOptions(bot: TelegramBot, agents: TeamComposeItem[]) {
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
      displayName: bot.agent.name,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: null,
      updatedAt: "",
    },
  ];
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

function TelegramStatusBadge({ connected }: { connected: boolean }) {
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
  disabled,
}: {
  agents: TeamComposeItem[];
  disabled: boolean;
}) {
  const botToken = useGet(telegramBotTokenForm$);
  const selectedAgentId = useGet(telegramBotAgentForm$);
  const agentId = selectedAgentId ?? DEFAULT_AGENT_VALUE;
  const setBotToken = useSet(setTelegramBotTokenForm$);
  const setAgentId = useSet(setTelegramBotAgentForm$);
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
              defaultAgentId:
                agentId === DEFAULT_AGENT_VALUE ? undefined : agentId,
            },
            pageSignal,
          ).then(() => {
            setBotToken("");
            setAgentId(null);
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
            value={agentId}
            disabled={disabled || adding}
            onValueChange={(value) => {
              setAgentId(value === DEFAULT_AGENT_VALUE ? null : value);
            }}
          >
            <SelectTrigger id="telegram-new-bot-agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_AGENT_VALUE}>Use default</SelectItem>
              {agents.map((agent) => {
                return (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agentLabel(agent)}
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

function TelegramBotRow({
  bot,
  agents,
  disabled,
}: {
  bot: TelegramBot;
  agents: TeamComposeItem[];
  disabled: boolean;
}) {
  const savingBotId = useGet(telegramSavingBotId$);
  const deletingBotId = useGet(telegramDisconnectingBotId$);
  const setSavingBotId = useSet(setTelegramSavingBotId$);
  const setDeletingBotId = useSet(setTelegramDisconnectingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, updateBotAgent] = useLoadableSet(updateTelegramBotAgent$);
  const [, disconnectBot] = useLoadableSet(disconnectTelegramBot$);
  const saving = savingBotId === bot.id;
  const deleting = deletingBotId === bot.id;
  const options = buildBotAgentOptions(bot, agents);

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
            <TelegramStatusBadge connected={bot.isConnected} />
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground">
            {bot.agent ? `Routes to ${bot.agent.name}` : "No default agent"}
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:w-[360px] sm:grid-cols-[1fr_auto]">
        <Select
          value={bot.agent?.id}
          disabled={disabled || saving || deleting || options.length === 0}
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
                  {agentLabel(agent)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || saving || deleting}
          className="h-9 gap-2 justify-center text-destructive hover:text-destructive sm:w-32"
          onClick={() => {
            setDeletingBotId(bot.id);
            detach(
              disconnectBot(bot.id, pageSignal).finally(() => {
                setDeletingBotId(null);
              }),
              Reason.DomCallback,
            );
          }}
        >
          {deleting ? (
            <IconLoader2 size={15} className="animate-spin" />
          ) : (
            <IconTrash size={15} />
          )}
          {deleting ? "Disconnecting..." : "Disconnect"}
        </Button>
        {saving ? (
          <div className="text-xs text-muted-foreground sm:col-span-2">
            Saving agent...
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TelegramBotList({
  bots,
  agents,
  agentsLoading,
}: {
  bots: TelegramBot[];
  agents: TeamComposeItem[];
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
  const bots = botsLoadable.state === "hasData" ? botsLoadable.data : [];
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
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
              <AddTelegramBotForm agents={agents} disabled={agentsLoading} />
              <TelegramBotList
                bots={bots}
                agents={agents}
                agentsLoading={agentsLoading}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
