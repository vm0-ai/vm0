import { Component, type FormEvent } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCircleCheck,
  IconDotsVertical,
  IconExternalLink,
  IconKey,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconRobot,
} from "@tabler/icons-react";
import type {
  TelegramBot,
  TelegramBotStatus,
  TelegramSetupStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { apiBase$ } from "../../signals/fetch.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  checkTelegramBotSetupStatus$,
  disconnectTelegramAccount$,
  registerTelegramBot$,
  reinstallTelegramBot$,
  setTelegramAddDialogOpen$,
  setTelegramReinstallDialogBotId$,
  setTelegramReinstallingBotId$,
  setTelegramReinstallTokenForm$,
  setTelegramBotAgentForm$,
  setTelegramBotTokenForm$,
  setTelegramSavingBotId$,
  setTelegramUninstallDialogBotId$,
  setTelegramUninstallingBotId$,
  setTelegramUnlinkingBotId$,
  telegramAddDialogOpen$,
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
import { BetaBadge } from "./components/settings/beta-badge.tsx";
import telegramIconImg from "./components/settings/icons/telegram.svg";
import { delay } from "signal-timers";

interface DefaultAgentLabel {
  id: string | null;
  displayName: string | null;
}

const TELEGRAM_COMMAND_CLASS =
  "cursor-pointer rounded border border-border bg-background px-1 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-accent active:bg-accent/80";
const BOT_FATHER_HANDLE = "@BotFather";

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

function TelegramSettingsSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="telegram-settings-loading"
    >
      <Skeleton className="h-4 w-64 max-w-full" />
      <div className="zero-card overflow-hidden">
        {[0, 1, 2].map((index) => {
          return (
            <div key={index}>
              <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-6 w-24 rounded-lg" />
                    </div>
                    <Skeleton className="h-4 w-40 max-w-full" />
                  </div>
                </div>
                <div className="grid gap-2 sm:w-[360px] sm:grid-cols-[1fr_auto]">
                  <Skeleton className="h-9 w-full rounded-md" />
                  <div className="flex items-center justify-end gap-1.5">
                    <Skeleton className="h-9 w-20 rounded-md" />
                    <Skeleton className="h-8 w-8 rounded-md" />
                  </div>
                </div>
              </div>
              {index < 2 ? (
                <div className="mx-5 border-b border-border/50" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddTelegramBotButtonSkeleton() {
  return <Skeleton className="h-10 w-[105px] shrink-0 rounded-md" />;
}

function telegramBotCountLabel(count: number): string {
  if (count === 0) {
    return "This organization has no Telegram bots";
  }
  return `This organization has ${String(count)} Telegram ${count === 1 ? "bot" : "bots"}`;
}

function TelegramBotCount({ count }: { count: number }) {
  return (
    <div
      data-testid="telegram-bot-count"
      className="text-sm text-muted-foreground"
    >
      {telegramBotCountLabel(count)}
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

function TelegramBotIconFallback({ botId }: { botId: string }) {
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#2AABEE]/10 text-[#2AABEE]"
      data-testid={`telegram-bot-avatar-fallback-${botId}`}
    >
      <IconRobot className="h-5 w-5" stroke={1.75} />
    </div>
  );
}

class TelegramBotAvatar extends Component<
  { bot: TelegramBot; avatarUrl: string | null },
  { failed: boolean }
> {
  state: { failed: boolean } = {
    failed: false,
  };

  componentDidUpdate(previousProps: {
    bot: TelegramBot;
    avatarUrl: string | null;
  }) {
    if (
      previousProps.bot.id !== this.props.bot.id ||
      previousProps.avatarUrl !== this.props.avatarUrl
    ) {
      this.setState({ failed: false });
    }
  }

  render() {
    const { bot, avatarUrl } = this.props;
    if (!avatarUrl || this.state.failed) {
      return <TelegramBotIconFallback botId={bot.id} />;
    }

    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        className="h-10 w-10 shrink-0 rounded-full object-cover"
        data-testid={`telegram-bot-avatar-${bot.id}`}
        onError={() => {
          this.setState({ failed: true });
        }}
      />
    );
  }
}

function resolveTelegramBotAvatarUrl(
  avatarUrl: string | null | undefined,
  apiBase: string,
): string | null {
  if (!avatarUrl) {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(avatarUrl)) {
    return avatarUrl;
  }
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  const path = avatarUrl.startsWith("/") ? avatarUrl : `/${avatarUrl}`;
  return `${base}${path}`;
}

function getTelegramLoginDomain(): string {
  if (typeof location === "undefined" || !location.hostname) {
    return "your app domain";
  }
  return location.hostname;
}

function getTelegramLoginOrigin(): string | undefined {
  if (typeof location === "undefined" || !location.origin) {
    return undefined;
  }
  return location.origin;
}

class CopyableTelegramValue extends Component<
  { value: string },
  { copied: boolean }
> {
  state: { copied: boolean } = {
    copied: false,
  };

  #resetTimer: number | null = null;

  componentWillUnmount() {
    if (this.#resetTimer !== null) {
      window.clearTimeout(this.#resetTimer);
    }
  }

  copyValue = () => {
    const { value } = this.props;
    detach(
      writeToClipboard(value).then((copied) => {
        if (!copied) {
          return;
        }
        if (this.#resetTimer !== null) {
          window.clearTimeout(this.#resetTimer);
        }
        this.setState({ copied: true });
        this.#resetTimer = window.setTimeout(() => {
          this.setState({ copied: false });
          this.#resetTimer = null;
        }, 1500);
      }),
      Reason.DomCallback,
    );
  };

  render() {
    const { value } = this.props;

    return (
      <button
        type="button"
        className={TELEGRAM_COMMAND_CLASS}
        aria-label={`Copy ${value}`}
        title="Click to copy"
        onClick={this.copyValue}
      >
        {this.state.copied ? "copied!" : value}
      </button>
    );
  }
}

function TelegramCommand({ command }: { command: string }) {
  return <CopyableTelegramValue value={command} />;
}

type AddTelegramStep = "token" | "domain" | "privacy" | "create";
type SetupPollTarget = "token" | "domain" | "privacy";

const ADD_TELEGRAM_STEP_ORDER = [
  "token",
  "domain",
  "privacy",
  "create",
] as const satisfies readonly AddTelegramStep[];

const ADD_TELEGRAM_STEPS = [
  { key: "token", label: "Token" },
  { key: "domain", label: "Domain" },
  { key: "privacy", label: "Privacy" },
  { key: "create", label: "Create" },
] as const satisfies readonly { key: AddTelegramStep; label: string }[];

const SETUP_POLL_ATTEMPTS = 20;
const SETUP_POLL_INTERVAL_MS = 2000;

function telegramStepIndex(step: AddTelegramStep): number {
  return ADD_TELEGRAM_STEPS.findIndex((item) => {
    return item.key === step;
  });
}

function AddTelegramBotProgress({
  step,
  completedSteps,
}: {
  step: AddTelegramStep;
  completedSteps: ReadonlySet<AddTelegramStep>;
}) {
  const currentIndex = telegramStepIndex(step);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {ADD_TELEGRAM_STEPS.map((item, index) => {
          const active = index === currentIndex;
          const complete = completedSteps.has(item.key);
          return (
            <div
              key={item.key}
              className={
                complete || active
                  ? "h-1 flex-1 rounded-full bg-foreground"
                  : "h-1 flex-1 rounded-full bg-muted"
              }
            />
          );
        })}
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        {ADD_TELEGRAM_STEPS.map((item, index) => {
          const active = index === currentIndex;
          const complete = completedSteps.has(item.key);
          return (
            <div
              key={item.key}
              className={
                active || complete
                  ? "truncate font-medium text-foreground"
                  : "truncate text-muted-foreground"
              }
            >
              {item.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TelegramSetupStatusLine({
  setupStatus,
}: {
  setupStatus: TelegramSetupStatus | null;
}) {
  if (!setupStatus) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <IconCircleCheck className="h-4 w-4 text-green-600" />
        Token verified
      </span>
      <span>
        {setupStatus.username ? `@${setupStatus.username}` : setupStatus.id}
      </span>
    </div>
  );
}

function AddTelegramBotTokenField({
  botToken,
  disabled,
  onBotTokenChange,
}: {
  botToken: string;
  disabled: boolean;
  onBotTokenChange: (value: string) => void;
}) {
  return (
    <div>
      <label
        htmlFor="telegram-bot-token"
        className="mb-2 block text-sm font-medium text-foreground"
      >
        Bot token
      </label>
      <div className="relative">
        <IconKey
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="telegram-bot-token"
          type="password"
          value={botToken}
          disabled={disabled}
          autoComplete="off"
          placeholder="123456:ABC-DEF"
          className="pl-9"
          onChange={(event) => {
            onBotTokenChange(event.target.value);
          }}
        />
      </div>
    </div>
  );
}

function AddTelegramBotAgentField({
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  disabled,
  onAgentChange,
}: {
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  disabled: boolean;
  onAgentChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor="telegram-new-bot-agent"
        className="mb-2 block text-sm font-medium text-foreground"
      >
        Default agent
      </label>
      <Select
        value={agentId ?? ""}
        disabled={disabled || agents.length === 0}
        onValueChange={onAgentChange}
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
  );
}

function SetupError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
      {message}
    </div>
  );
}

function AddTelegramTokenStep({
  domain,
  botToken,
  disabled,
  checking,
  setupStatus,
  setupError,
  onBotTokenChange,
  onVerify,
}: {
  domain: string;
  botToken: string;
  disabled: boolean;
  checking: boolean;
  setupStatus: TelegramSetupStatus | null;
  setupError: string | null;
  onBotTokenChange: (value: string) => void;
  onVerify: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          Create a bot token in BotFather
        </div>
        <div className="leading-relaxed">
          Open{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            {BOT_FATHER_HANDLE}
            <IconExternalLink className="h-3.5 w-3.5" />
          </a>
          , send <TelegramCommand command="/newbot" />, choose a name and
          username, then paste the token below. Later steps will set this
          workspace&apos;s login domain to{" "}
          <CopyableTelegramValue value={domain} />.
        </div>
      </div>
      <AddTelegramBotTokenField
        botToken={botToken}
        disabled={disabled || checking}
        onBotTokenChange={onBotTokenChange}
      />
      <TelegramSetupStatusLine setupStatus={setupStatus} />
      <SetupError message={setupError} />
      <Button
        type="button"
        variant="outline"
        disabled={disabled || checking || botToken.trim().length === 0}
        className="gap-2"
        onClick={onVerify}
      >
        {checking ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconKey size={16} />
        )}
        {checking ? "Verifying..." : "Verify token"}
      </Button>
    </div>
  );
}

function AddTelegramDomainStep({
  domain,
  confirmed,
  checking,
  setupError,
  onCheck,
}: {
  domain: string;
  confirmed: boolean;
  checking: boolean;
  setupError: string | null;
  onCheck: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          Set the Telegram login domain
        </div>
        <div className="leading-relaxed">
          In {BOT_FATHER_HANDLE}, send <TelegramCommand command="/setdomain" />,
          choose this bot, and set the domain to{" "}
          <CopyableTelegramValue value={domain} />.
        </div>
      </div>
      {confirmed ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-600/20 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-300">
          <IconCircleCheck className="h-4 w-4" />
          Domain detected
        </div>
      ) : null}
      <SetupError message={setupError} />
      <Button
        type="button"
        variant="outline"
        disabled={checking || confirmed}
        className="gap-2"
        onClick={onCheck}
      >
        {checking ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconRefresh size={16} />
        )}
        {checking ? "Checking domain..." : "Check domain"}
      </Button>
    </div>
  );
}

function AddTelegramPrivacyStep({
  confirmed,
  skipped,
  checking,
  setupError,
  onCheck,
  onSkip,
}: {
  confirmed: boolean;
  skipped: boolean;
  checking: boolean;
  setupError: string | null;
  onCheck: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          Optional: turn off privacy mode
        </div>
        <div className="leading-relaxed">
          In {BOT_FATHER_HANDLE}, send <TelegramCommand command="/setprivacy" />
          , choose this bot, then disable privacy mode.
        </div>
      </div>
      <div className="rounded-lg border border-border px-4 py-3 text-sm">
        <div className="mb-2 font-medium text-foreground">
          If you keep privacy mode on
        </div>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li>Direct messages still work.</li>
          <li>
            Group chats only send commands, mentions, and replies to the bot.
          </li>
          <li>Normal group messages will not trigger your agent.</li>
        </ul>
      </div>
      {confirmed ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-600/20 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-300">
          <IconCircleCheck className="h-4 w-4" />
          Privacy mode is off
        </div>
      ) : skipped ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <IconAlertTriangle className="h-4 w-4" />
          Privacy mode will stay on for now
        </div>
      ) : null}
      <SetupError message={setupError} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={checking || confirmed}
          className="gap-2"
          onClick={onCheck}
        >
          {checking ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : (
            <IconRefresh size={16} />
          )}
          {checking ? "Checking privacy..." : "Check privacy"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={checking || confirmed}
          onClick={onSkip}
        >
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function AddTelegramCreateStep({
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  setupStatus,
  privacySkipped,
  disabled,
  onAgentChange,
}: {
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  setupStatus: TelegramSetupStatus | null;
  privacySkipped: boolean;
  disabled: boolean;
  onAgentChange: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          Ready to create the integration
        </div>
        <div>
          {setupStatus?.username
            ? `VM0 will register @${setupStatus.username} and configure its webhook.`
            : "VM0 will register this bot and configure its webhook."}
        </div>
      </div>
      {privacySkipped ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Privacy mode was skipped. You can still create the bot, but normal
          group messages will not reach VM0 until privacy mode is disabled.
        </div>
      ) : null}
      <AddTelegramBotAgentField
        agents={agents}
        defaultAgent={defaultAgent}
        agentId={agentId}
        selectedAgentLabel={selectedAgentLabel}
        disabled={disabled}
        onAgentChange={onAgentChange}
      />
    </div>
  );
}

type CheckTelegramBotSetupStatus = (
  input: { botToken: string; origin?: string },
  signal: AbortSignal,
) => Promise<TelegramSetupStatus>;

interface AddTelegramBotSetupFlow {
  step: AddTelegramStep;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyConfirmed: boolean;
  privacySkipped: boolean;
  setupError: string | null;
  checkingTarget: SetupPollTarget | null;
  completedSteps: Set<AddTelegramStep>;
  canGoNext: boolean;
  reset: () => void;
  handleBotTokenChange: (value: string) => void;
  verifyToken: () => void;
  checkDomain: () => void;
  checkPrivacy: () => void;
  skipPrivacy: () => void;
  goNext: () => void;
  goBack: () => void;
}

function getSelectedAddTelegramAgent({
  agents,
  defaultAgent,
  selectedAgentId,
}: {
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  selectedAgentId: string | null | undefined;
}) {
  const preferredAgentId = selectedAgentId ?? defaultAgent.id ?? agents[0]?.id;
  const selectedAgent =
    agents.find((agent) => {
      return agent.id === preferredAgentId;
    }) ?? agents[0];

  return {
    agentId: selectedAgent?.id,
    selectedAgentLabel: selectedAgent
      ? agentLabel(selectedAgent, defaultAgent)
      : (defaultAgent.displayName ?? "Select agent"),
  };
}

function getCompletedAddTelegramSteps({
  setupStatus,
  domainConfirmed,
  privacyReady,
}: {
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyReady: boolean;
}) {
  const completedSteps = new Set<AddTelegramStep>();
  if (setupStatus) {
    completedSteps.add("token");
  }
  if (domainConfirmed) {
    completedSteps.add("domain");
  }
  if (privacyReady) {
    completedSteps.add("privacy");
  }
  return completedSteps;
}

function canAdvanceAddTelegramStep({
  step,
  setupStatus,
  domainConfirmed,
  privacyReady,
}: {
  step: AddTelegramStep;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyReady: boolean;
}) {
  switch (step) {
    case "token": {
      return !!setupStatus;
    }
    case "domain": {
      return domainConfirmed;
    }
    case "privacy": {
      return privacyReady;
    }
    case "create": {
      return false;
    }
  }
}

function canSubmitAddTelegramBot({
  botToken,
  setupStatus,
  domainConfirmed,
  privacyReady,
  disabled,
  adding,
}: {
  botToken: string;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyReady: boolean;
  disabled: boolean;
  adding: boolean;
}) {
  return (
    botToken.trim().length > 0 &&
    !!setupStatus &&
    domainConfirmed &&
    privacyReady &&
    !disabled &&
    !adding
  );
}

function getNextAddTelegramStep(step: AddTelegramStep): AddTelegramStep {
  const index = telegramStepIndex(step);
  if (index < 0) {
    return step;
  }
  return ADD_TELEGRAM_STEP_ORDER[index + 1] ?? step;
}

function getPreviousAddTelegramStep(step: AddTelegramStep): AddTelegramStep {
  const index = telegramStepIndex(step);
  if (index < 1) {
    return step;
  }
  return ADD_TELEGRAM_STEP_ORDER[index - 1] ?? step;
}

function shouldStopSetupPolling(
  target: SetupPollTarget,
  status: TelegramSetupStatus,
) {
  switch (target) {
    case "token": {
      return true;
    }
    case "domain": {
      return status.domainConfigured;
    }
    case "privacy": {
      return status.privacyDisabled;
    }
  }
}

function getSetupPollingTimeoutMessage(target: SetupPollTarget) {
  if (target === "domain") {
    return "Domain is not visible to Telegram yet. Check BotFather and try again.";
  }
  return "Privacy mode still appears to be on. You can keep checking or skip this step.";
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

interface AddTelegramBotSetupState {
  step: AddTelegramStep;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyConfirmed: boolean;
  privacySkipped: boolean;
  setupError: string | null;
  checkingTarget: SetupPollTarget | null;
}

function initialAddTelegramBotSetupState(): AddTelegramBotSetupState {
  return {
    step: "token",
    setupStatus: null,
    domainConfirmed: false,
    privacyConfirmed: false,
    privacySkipped: false,
    setupError: null,
    checkingTarget: null,
  };
}

interface AddTelegramBotDialogInnerProps {
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
  botToken: string;
  open: boolean;
  agentId: string | undefined;
  selectedAgentLabel: string;
  setBotToken: (value: string) => void;
  setAgentId: (value: string | null) => void;
  setOpen: (open: boolean) => void;
  navigate: (
    pathname: typeof ROUTES.telegramConnect,
    options: { searchParams: URLSearchParams },
  ) => void;
  registerBot: (
    input: { botToken: string; defaultAgentId?: string },
    signal: AbortSignal,
  ) => Promise<TelegramBotStatus>;
  checkSetupStatus: CheckTelegramBotSetupStatus;
  pageSignal: AbortSignal;
  adding: boolean;
}

class AddTelegramBotDialogInner extends Component<
  AddTelegramBotDialogInnerProps,
  AddTelegramBotSetupState
> {
  state = initialAddTelegramBotSetupState();

  #flowVersion = 0;

  #privacyReady() {
    return this.state.privacyConfirmed || this.state.privacySkipped;
  }

  #reset = () => {
    this.#flowVersion += 1;
    this.setState(initialAddTelegramBotSetupState());
  };

  #applySetupStatus = (status: TelegramSetupStatus) => {
    this.setState((previous) => {
      return {
        setupStatus: status,
        domainConfirmed: previous.domainConfirmed || status.domainConfigured,
        privacyConfirmed: previous.privacyConfirmed || status.privacyDisabled,
        privacySkipped: status.privacyDisabled
          ? false
          : previous.privacySkipped,
      };
    });
  };

  #pollSetupStatus = (target: SetupPollTarget): Promise<void> => {
    const token = this.props.botToken.trim();
    if (!token) {
      return Promise.resolve();
    }

    const currentFlowVersion = this.#flowVersion;
    this.setState({ checkingTarget: target, setupError: null });

    return this.#runSetupStatusPolling(target, token, currentFlowVersion)
      .catch((error: unknown) => {
        this.#handleSetupStatusPollingError(error, currentFlowVersion);
      })
      .finally(() => {
        if (this.#flowVersion === currentFlowVersion) {
          this.setState({ checkingTarget: null });
        }
      });
  };

  #runSetupStatusPolling = async (
    target: SetupPollTarget,
    token: string,
    currentFlowVersion: number,
  ) => {
    const attempts = target === "token" ? 1 : SETUP_POLL_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const status = await this.props.checkSetupStatus(
        { botToken: token, origin: getTelegramLoginOrigin() },
        this.props.pageSignal,
      );
      if (this.#flowVersion !== currentFlowVersion) {
        return;
      }
      this.#applySetupStatus(status);

      if (shouldStopSetupPolling(target, status)) {
        return;
      }

      if (attempt < attempts - 1) {
        await delay(SETUP_POLL_INTERVAL_MS, { signal: this.props.pageSignal });
      }
    }

    this.setState({ setupError: getSetupPollingTimeoutMessage(target) });
  };

  #handleSetupStatusPollingError = (
    error: unknown,
    currentFlowVersion: number,
  ) => {
    if (isAbortError(error) || this.#flowVersion !== currentFlowVersion) {
      return;
    }
    this.setState({
      setupError:
        error instanceof Error
          ? error.message
          : "Unable to check Telegram setup status.",
    });
  };

  #handleBotTokenChange = (value: string) => {
    this.props.setBotToken(value);
    this.#reset();
  };

  #skipPrivacy = () => {
    this.setState({ privacySkipped: true, setupError: null });
  };

  #goNext = () => {
    this.setState((previous) => {
      return { step: getNextAddTelegramStep(previous.step), setupError: null };
    });
  };

  #goBack = () => {
    this.setState((previous) => {
      return {
        step: getPreviousAddTelegramStep(previous.step),
        setupError: null,
      };
    });
  };

  #getFlow(): AddTelegramBotSetupFlow {
    return {
      ...this.state,
      completedSteps: getCompletedAddTelegramSteps({
        setupStatus: this.state.setupStatus,
        domainConfirmed: this.state.domainConfirmed,
        privacyReady: this.#privacyReady(),
      }),
      canGoNext: canAdvanceAddTelegramStep({
        step: this.state.step,
        setupStatus: this.state.setupStatus,
        domainConfirmed: this.state.domainConfirmed,
        privacyReady: this.#privacyReady(),
      }),
      reset: this.#reset,
      handleBotTokenChange: this.#handleBotTokenChange,
      verifyToken: () => {
        detach(this.#pollSetupStatus("token"), Reason.DomCallback);
      },
      checkDomain: () => {
        detach(this.#pollSetupStatus("domain"), Reason.DomCallback);
      },
      checkPrivacy: () => {
        detach(this.#pollSetupStatus("privacy"), Reason.DomCallback);
      },
      skipPrivacy: this.#skipPrivacy,
      goNext: this.#goNext,
      goBack: this.#goBack,
    };
  }

  #canSubmit() {
    return canSubmitAddTelegramBot({
      botToken: this.props.botToken,
      setupStatus: this.state.setupStatus,
      domainConfirmed: this.state.domainConfirmed,
      privacyReady: this.#privacyReady(),
      disabled: this.props.disabled,
      adding: this.props.adding,
    });
  }

  #handleOpenChange = (nextOpen: boolean) => {
    if (this.props.adding) {
      return;
    }

    this.props.setOpen(nextOpen);
    if (!nextOpen) {
      this.#reset();
    }
  };

  #handleCancel = () => {
    this.props.setOpen(false);
    this.#reset();
  };

  #handleRegisteredBot = (bot: TelegramBotStatus) => {
    this.props.setBotToken("");
    this.props.setAgentId(null);
    this.#reset();
    this.props.setOpen(false);
    this.props.navigate(ROUTES.telegramConnect, {
      searchParams: new URLSearchParams({ bot: bot.id }),
    });
  };

  #handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!this.#canSubmit()) {
      return;
    }

    detach(
      this.props
        .registerBot(
          {
            botToken: this.props.botToken.trim(),
            ...(this.props.agentId
              ? { defaultAgentId: this.props.agentId }
              : {}),
          },
          this.props.pageSignal,
        )
        .then(this.#handleRegisteredBot),
      Reason.DomCallback,
    );
  };

  render() {
    const flow = this.#getFlow();

    return (
      <Dialog open={this.props.open} onOpenChange={this.#handleOpenChange}>
        <div className="flex shrink-0 justify-end">
          <DialogTrigger asChild>
            <Button
              type="button"
              disabled={this.props.disabled}
              className="h-10 shrink-0 gap-2"
            >
              <IconPlus size={16} />
              Add bot
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>Add Telegram bot</DialogTitle>
            <DialogDescription>
              Complete each BotFather step, then create the workspace bot.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            aria-label="Register Telegram bot"
            onSubmit={this.#handleSubmit}
          >
            <AddTelegramBotProgress
              step={flow.step}
              completedSteps={flow.completedSteps}
            />
            <AddTelegramBotStepContent
              flow={flow}
              domain={getTelegramLoginDomain()}
              botToken={this.props.botToken}
              disabled={this.props.disabled}
              adding={this.props.adding}
              agents={this.props.agents}
              defaultAgent={this.props.defaultAgent}
              agentId={this.props.agentId}
              selectedAgentLabel={this.props.selectedAgentLabel}
              onAgentChange={this.props.setAgentId}
            />
            <AddTelegramBotDialogFooter
              step={flow.step}
              adding={this.props.adding}
              canGoNext={flow.canGoNext}
              checkingTarget={flow.checkingTarget}
              canSubmit={this.#canSubmit()}
              onCancel={this.#handleCancel}
              onBack={flow.goBack}
              onNext={flow.goNext}
            />
          </form>
        </DialogContent>
      </Dialog>
    );
  }
}

function AddTelegramBotStepContent({
  flow,
  domain,
  botToken,
  disabled,
  adding,
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  onAgentChange,
}: {
  flow: AddTelegramBotSetupFlow;
  domain: string;
  botToken: string;
  disabled: boolean;
  adding: boolean;
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  onAgentChange: (value: string) => void;
}) {
  switch (flow.step) {
    case "token": {
      return (
        <AddTelegramTokenStep
          domain={domain}
          botToken={botToken}
          disabled={disabled || adding}
          checking={flow.checkingTarget === "token"}
          setupStatus={flow.setupStatus}
          setupError={flow.setupError}
          onBotTokenChange={flow.handleBotTokenChange}
          onVerify={flow.verifyToken}
        />
      );
    }
    case "domain": {
      return (
        <AddTelegramDomainStep
          domain={domain}
          confirmed={flow.domainConfirmed}
          checking={flow.checkingTarget === "domain"}
          setupError={flow.setupError}
          onCheck={flow.checkDomain}
        />
      );
    }
    case "privacy": {
      return (
        <AddTelegramPrivacyStep
          confirmed={flow.privacyConfirmed}
          skipped={flow.privacySkipped}
          checking={flow.checkingTarget === "privacy"}
          setupError={flow.setupError}
          onCheck={flow.checkPrivacy}
          onSkip={flow.skipPrivacy}
        />
      );
    }
    case "create": {
      return (
        <AddTelegramCreateStep
          agents={agents}
          defaultAgent={defaultAgent}
          agentId={agentId}
          selectedAgentLabel={selectedAgentLabel}
          setupStatus={flow.setupStatus}
          privacySkipped={flow.privacySkipped}
          disabled={disabled || adding}
          onAgentChange={onAgentChange}
        />
      );
    }
  }
}

function AddTelegramBotDialogFooter({
  step,
  adding,
  canGoNext,
  checkingTarget,
  canSubmit,
  onCancel,
  onBack,
  onNext,
}: {
  step: AddTelegramStep;
  adding: boolean;
  canGoNext: boolean;
  checkingTarget: SetupPollTarget | null;
  canSubmit: boolean;
  onCancel: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const isTokenStep = step === "token";
  const isCreateStep = step === "create";

  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={adding}
        onClick={isTokenStep ? onCancel : onBack}
      >
        {isTokenStep ? (
          "Cancel"
        ) : (
          <span className="inline-flex items-center gap-2">
            <IconArrowLeft size={16} />
            Back
          </span>
        )}
      </Button>
      {isCreateStep ? (
        <Button type="submit" disabled={!canSubmit} className="gap-2">
          {adding ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : (
            <IconPlus size={16} />
          )}
          {adding ? "Adding..." : "Add bot"}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={!canGoNext || !!checkingTarget || adding}
          className="gap-2"
          onClick={onNext}
        >
          Next
          <IconArrowRight size={16} />
        </Button>
      )}
    </DialogFooter>
  );
}

function AddTelegramBotDialog({
  agents,
  defaultAgent,
  disabled,
}: {
  agents: TeamComposeItem[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
}) {
  const botToken = useGet(telegramBotTokenForm$);
  const open = useGet(telegramAddDialogOpen$);
  const selectedAgentId = useGet(telegramBotAgentForm$);
  const { agentId, selectedAgentLabel } = getSelectedAddTelegramAgent({
    agents,
    defaultAgent,
    selectedAgentId,
  });
  const setBotToken = useSet(setTelegramBotTokenForm$);
  const setAgentId = useSet(setTelegramBotAgentForm$);
  const setOpen = useSet(setTelegramAddDialogOpen$);
  const navigate = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);
  const checkSetupStatus = useSet(checkTelegramBotSetupStatus$);
  const [registerLoadable, registerBot] = useLoadableSet(registerTelegramBot$);
  const adding = registerLoadable.state === "loading";

  return (
    <AddTelegramBotDialogInner
      agents={agents}
      defaultAgent={defaultAgent}
      disabled={disabled}
      botToken={botToken}
      open={open}
      agentId={agentId}
      selectedAgentLabel={selectedAgentLabel}
      setBotToken={setBotToken}
      setAgentId={setAgentId}
      setOpen={setOpen}
      navigate={navigate}
      registerBot={registerBot}
      checkSetupStatus={checkSetupStatus}
      pageSignal={pageSignal}
      adding={adding}
    />
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
  const apiBase = useGet(apiBase$);
  const saving = savingBotId === bot.id;
  const unlinking = unlinkingBotId === bot.id;
  const uninstalling = uninstallingBotId === bot.id;
  const reinstalling = reinstallingBotId === bot.id;
  const actionDisabled =
    disabled || saving || unlinking || uninstalling || reinstalling;
  const options = buildBotAgentOptions(bot, agents, defaultAgent);
  const avatarUrl = resolveTelegramBotAvatarUrl(bot.avatarUrl, apiBase);

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TelegramBotAvatar bot={bot} avatarUrl={avatarUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">
              {bot.username ? `@${bot.username}` : "Telegram bot"}
            </div>
            <TelegramStatusBadge bot={bot} />
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
  const loading = botsLoadable.state === "loading" && bots.length === 0;
  const hasError =
    botsLoadable.state === "hasError" || agentsLoadable.state === "hasError";
  const agentsLoading = agentsLoadable.state === "loading";

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
                <img src={telegramIconImg} alt="" className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    Telegram
                  </h1>
                  <BetaBadge />
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Manage bot routing for this workspace
                </p>
              </div>
            </div>
            {!hasError && loading ? (
              <AddTelegramBotButtonSkeleton />
            ) : !hasError ? (
              <AddTelegramBotDialog
                agents={agents}
                defaultAgent={defaultAgent}
                disabled={agentsLoading}
              />
            ) : null}
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
              <TelegramBotCount count={bots.length} />
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
