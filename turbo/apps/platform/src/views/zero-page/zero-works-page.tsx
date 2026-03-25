import { useGet, useSet, useLoadable, useLastResolved } from "ccstate-react";
import { useState } from "react";
import {
  IconBrandTelegram,
  IconCircleCheck,
  IconDotsVertical,
  IconDownload,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import { FeatureSwitchKey } from "@vm0/core";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  slackOrgData$,
  disconnectSlackOrg$,
  uninstallSlackOrg$,
  showUninstallDialog$,
  setShowUninstallDialog$,
} from "../../signals/zero-page/zero-slack.ts";
import {
  telegramOrgData$,
  installTelegramOrg$,
  connectTelegramOrg$,
  toggleTelegramOrg$,
  disconnectTelegramOrg$,
  uninstallTelegramOrg$,
  showTelegramInstallDialog$,
  setShowTelegramInstallDialog$,
  showTelegramUninstallDialog$,
  setShowTelegramUninstallDialog$,
} from "../../signals/zero-page/zero-telegram.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import slackIconImg from "./assets/slack-icon.svg";

/** Append a cache-busting timestamp so the browser never reuses a cached OAuth redirect. */
function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  fresh.searchParams.set("_t", String(Date.now()));
  window.open(fresh.toString(), "_blank");
}

function SlackCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  installUrl,
  connectUrl,
  onDisconnect,
  onUninstall,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  installUrl: string | null | undefined;
  connectUrl: string | null | undefined;
  onDisconnect: () => void;
  onUninstall: () => void;
}) {
  return (
    <>
      {isConnected ? (
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
          <IconCircleCheck className="h-3 w-3 text-green-600" />
          Connected
        </span>
      ) : null}
      {!isInstalled && isAdmin && installUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => openFreshOAuth(installUrl)}
        >
          <IconDownload size={14} stroke={1.5} />
          Install to Slack
        </Button>
      )}
      {isInstalled && !isConnected && connectUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => openFreshOAuth(connectUrl)}
        >
          Connect
        </Button>
      )}
      {isInstalled && (isConnected || isAdmin) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="More options"
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            {isConnected && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onDisconnect}
              >
                Disconnect
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onUninstall}
              >
                Uninstall
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function SlackCard({ displayName }: { displayName: string }) {
  const slackData = useGet(slackOrgData$);
  const disconnect = useSet(disconnectSlackOrg$);
  const uninstall = useSet(uninstallSlackOrg$);

  const showUninstallDialog = useGet(showUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowUninstallDialog$);

  const isConnected = slackData?.isConnected ?? false;
  const isInstalled = slackData?.isInstalled ?? isConnected;
  const isAdmin = slackData?.isAdmin ?? false;

  return (
    <>
      <div className="zero-card flex items-center gap-4 p-4">
        <div className="shrink-0">
          <img src={slackIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Slack</div>
          <div className="text-sm text-muted-foreground">
            {!isInstalled && !isAdmin
              ? "Ask your admin to install the Slack integration"
              : "Team communication and collaboration"}
          </div>
        </div>
        <SlackCardActions
          isConnected={isConnected}
          isInstalled={isInstalled}
          isAdmin={isAdmin}
          installUrl={slackData?.installUrl}
          connectUrl={slackData?.connectUrl}
          onDisconnect={() => detach(disconnect(), Reason.DomCallback)}
          onUninstall={() => setShowUninstallDialog(true)}
        />
      </div>

      <Dialog open={showUninstallDialog} onOpenChange={setShowUninstallDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall Slack integration?</DialogTitle>
            <DialogDescription>
              This will remove the Slack integration for your entire workspace.
              All connected users will be disconnected and {displayName} will no
              longer respond to messages or mentions in Slack. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUninstallDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowUninstallDialog(false);
                detach(uninstall(), Reason.DomCallback);
              }}
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * Open the Telegram Login Widget popup. The callback page at
 * /api/zero/integrations/telegram/auth-callback sends auth data back via
 * `postMessage({ type: "telegram-auth", data })`.
 */
function openTelegramLogin(botId: string) {
  const callbackUrl = `${window.location.origin}/api/zero/integrations/telegram/auth-callback`;
  const url = `https://oauth.telegram.org/auth?bot_id=${botId}&origin=${encodeURIComponent(window.location.origin)}&return_to=${encodeURIComponent(callbackUrl)}`;
  window.open(url, "_blank", "width=550,height=450");
}

function TelegramInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const telegramData = useGet(telegramOrgData$);
  const install = useSet(installTelegramOrg$);

  const [botToken, setBotToken] = useState("");
  const [installing, setInstalling] = useState(false);

  const domainConfigured = telegramData?.domainConfigured ?? false;

  // Can only proceed to login step when we have a token and domain is ready
  const canLogin = botToken.trim().length > 10 && domainConfigured;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install Telegram Bot</DialogTitle>
          <DialogDescription>
            Enter your bot token from @BotFather, then verify your Telegram
            identity.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {!domainConfigured && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              Your domain must be configured before installing a Telegram bot.
              Please set up your domain in Settings first.
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label
              htmlFor="telegram-bot-token"
              className="text-sm font-medium text-foreground"
            >
              Bot Token
            </label>
            <Input
              id="telegram-bot-token"
              type="password"
              placeholder="123456:ABC-DEF1234..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              disabled={installing}
            />
            <p className="text-xs text-muted-foreground">
              Get this from{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                @BotFather
              </a>{" "}
              on Telegram.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canLogin || installing}
            onClick={() => {
              // Extract bot ID from token (format: "botId:secretPart")
              const extractedBotId = botToken.split(":")[0];
              if (!extractedBotId) {
                return;
              }

              // Listen for postMessage from Login Widget popup
              const onMessage = (e: MessageEvent) => {
                if (
                  e.origin !== window.location.origin ||
                  e.data?.type !== "telegram-auth"
                ) {
                  return;
                }
                window.removeEventListener("message", onMessage);
                const auth = e.data.data as Record<string, unknown>;
                setInstalling(true);
                detach(
                  (async () => {
                    const result = await install({
                      botToken,
                      telegramAuth: auth,
                    });
                    setInstalling(false);
                    if (result) {
                      onOpenChange(false);
                      setBotToken("");
                    }
                  })(),
                  Reason.DomCallback,
                );
              };
              window.addEventListener("message", onMessage);
              openTelegramLogin(extractedBotId);
            }}
          >
            {installing ? "Installing…" : "Continue with Telegram"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TelegramCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  enabled,
  botId,
  onToggle,
  onDisconnect,
  onUninstall,
  onInstall,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  enabled: boolean;
  botId: string | null;
  onToggle: (enabled: boolean) => void;
  onDisconnect: () => void;
  onUninstall: () => void;
  onInstall: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const connect = useSet(connectTelegramOrg$);

  return (
    <>
      {isConnected ? (
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
          <IconCircleCheck className="h-3 w-3 text-green-600" />
          Connected
        </span>
      ) : null}
      {isInstalled && isAdmin && (
        <LoadingSwitch
          checked={enabled}
          loading={toggling}
          onCheckedChange={(val) => {
            setToggling(true);
            onToggle(val);
            setToggling(false);
          }}
          ariaLabel="Toggle Telegram bot"
        />
      )}
      {!isInstalled && isAdmin && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={onInstall}
        >
          <IconDownload size={14} stroke={1.5} />
          Install Telegram
        </Button>
      )}
      {isInstalled && !isConnected && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            if (!botId) {
              return;
            }
            const onMessage = (e: MessageEvent) => {
              if (
                e.origin !== window.location.origin ||
                e.data?.type !== "telegram-auth"
              ) {
                return;
              }
              window.removeEventListener("message", onMessage);
              const auth = e.data.data as Record<string, unknown>;
              detach(connect({ telegramAuth: auth }), Reason.DomCallback);
            };
            window.addEventListener("message", onMessage);
            openTelegramLogin(botId);
          }}
        >
          Connect
        </Button>
      )}
      {isInstalled && (isConnected || isAdmin) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="More options"
            >
              <IconDotsVertical size={16} stroke={1.5} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            {isConnected && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onDisconnect}
              >
                Disconnect
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={onUninstall}
              >
                Uninstall
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function TelegramCard({ displayName }: { displayName: string }) {
  const telegramData = useGet(telegramOrgData$);
  const toggle = useSet(toggleTelegramOrg$);
  const disconnect = useSet(disconnectTelegramOrg$);
  const uninstall = useSet(uninstallTelegramOrg$);

  const showInstallDialog = useGet(showTelegramInstallDialog$);
  const setShowInstallDialog = useSet(setShowTelegramInstallDialog$);
  const showUninstallTgDialog = useGet(showTelegramUninstallDialog$);
  const setShowUninstallTgDialog = useSet(setShowTelegramUninstallDialog$);

  const isConnected = telegramData?.isConnected ?? false;
  const isInstalled = telegramData?.isInstalled ?? isConnected;
  const isAdmin = telegramData?.isAdmin ?? false;
  const enabled = telegramData?.enabled ?? true;

  return (
    <>
      <div className="zero-card flex items-center gap-4 p-4">
        <div className="shrink-0">
          <IconBrandTelegram className="h-7 w-7 text-[#26A5E4]" />
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Telegram</div>
          <div className="text-sm text-muted-foreground">
            {!isInstalled && !isAdmin
              ? "Ask your admin to install the Telegram integration"
              : "Messaging and bot interactions"}
          </div>
        </div>
        <TelegramCardActions
          isConnected={isConnected}
          isInstalled={isInstalled}
          isAdmin={isAdmin}
          enabled={enabled}
          botId={telegramData?.bot?.id ?? null}
          onToggle={(val) => detach(toggle(val), Reason.DomCallback)}
          onDisconnect={() => detach(disconnect(), Reason.DomCallback)}
          onUninstall={() => setShowUninstallTgDialog(true)}
          onInstall={() => setShowInstallDialog(true)}
        />
      </div>

      <TelegramInstallDialog
        open={showInstallDialog}
        onOpenChange={setShowInstallDialog}
      />

      <Dialog
        open={showUninstallTgDialog}
        onOpenChange={setShowUninstallTgDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall Telegram integration?</DialogTitle>
            <DialogDescription>
              This will remove the Telegram bot for your entire workspace. All
              connected users will be disconnected and {displayName} will no
              longer respond to messages in Telegram. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowUninstallTgDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowUninstallTgDialog(false);
                detach(uninstall(), Reason.DomCallback);
              }}
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ZeroWorksPage() {
  const displayNameLoadable = useLoadable(agentDisplayName$);
  const displayName =
    displayNameLoadable.state === "hasData" ? displayNameLoadable.data : "Zero";

  const features = useLastResolved(featureSwitch$);
  const showTelegram =
    features?.[FeatureSwitchKey.TelegramIntegration] ?? false;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Where {displayName} works
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect with {displayName} through these channels
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <SlackCard displayName={displayName} />
          {showTelegram && <TelegramCard displayName={displayName} />}
        </div>
      </main>
    </div>
  );
}
