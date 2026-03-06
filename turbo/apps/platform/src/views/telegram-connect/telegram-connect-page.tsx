import { useGet, useSet } from "ccstate-react";
import { IconCheck } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { theme$ } from "../../signals/theme.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import {
  telegramConnectStatus$,
  telegramConnectIsLinked$,
  telegramConnectError$,
  telegramConnectInstallation$,
  telegramConnectParams$,
  telegramConnectStep$,
  telegramConnectDomainConfigured$,
  telegramConnectBotUsername$,
  telegramConnectBotId$,
  telegramBotToken$,
  setTelegramBotToken$,
  registerTelegramBot$,
  linkTelegramBot$,
  skipTelegramConnect$,
  openTelegramConnectLoginPopup$,
} from "../../signals/telegram-connect/telegram-connect.ts";
import { copyStatus$, copyToClipboard$ } from "../../signals/onboarding.ts";
import { detach, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// Step: Install
// ---------------------------------------------------------------------------

function InstallStep({
  botToken,
  status,
  error,
  onTokenChange,
  onRegister,
  onCancel,
}: {
  botToken: string;
  status: string;
  error: string | null;
  onTokenChange: (value: string) => void;
  onRegister: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1 text-center text-foreground">
        <h1 className="text-lg font-medium leading-7">
          Install a Telegram Bot
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          Enter your bot token from{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            @BotFather
          </a>{" "}
          to install your Telegram bot on VM0.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Input
          type="password"
          placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
          value={botToken}
          onChange={(e) => onTokenChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onRegister();
            }
          }}
        />
      </div>

      {error && (
        <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Button
          onClick={onRegister}
          disabled={!botToken.trim() || status === "registering"}
          className="w-full"
        >
          {status === "registering" ? "Installing..." : "Install Bot"}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          onClick={onCancel}
          disabled={status === "registering"}
        >
          Cancel
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step: Connect Account
// ---------------------------------------------------------------------------

function ConnectAccountStep({
  domainConfigured,
  botId,
  copyStatus,
  status,
  error,
  onConnect,
  onSkip,
  onCopyDomain,
}: {
  domainConfigured: boolean;
  botId: string | null;
  copyStatus: string;
  status: string;
  error: string | null;
  onConnect: () => void;
  onSkip: () => void;
  onCopyDomain: () => void;
}) {
  const isLinking = status === "linking";

  return (
    <>
      <div className="flex flex-col gap-1 text-center text-foreground">
        <h1 className="text-lg font-medium leading-7">
          Connect Your Telegram Account
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          Link your Telegram account to start chatting with your bot.
        </p>
      </div>

      {!domainConfigured && (
        <p className="text-center text-sm text-amber-600 dark:text-amber-500">
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
            {copyStatus === "copied" ? "Copied!" : window.location.hostname}
          </code>
          {" to enable web login."}
        </p>
      )}

      {error && (
        <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {botId && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="w-full">
                  <Button
                    className="w-full"
                    disabled={!domainConfigured || isLinking}
                    onClick={onConnect}
                  >
                    {isLinking ? "Connecting..." : "Connect"}
                  </Button>
                </span>
              </TooltipTrigger>
              {!domainConfigured && (
                <TooltipContent>
                  Telegram requires a verified domain for web login. Run
                  /setdomain in @BotFather first, or use /connect in Telegram.
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        <Button
          className="w-full"
          variant="outline"
          onClick={onSkip}
          disabled={isLinking}
        >
          Skip
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step: Complete
// ---------------------------------------------------------------------------

function CompleteStep({
  botUsername,
  onGoToSettings,
}: {
  botUsername: string | null;
  onGoToSettings: () => void;
}) {
  return (
    <>
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-950/40">
          <IconCheck size={24} className="text-green-600" stroke={2} />
        </div>
        <div className="flex flex-col gap-1 text-center text-foreground">
          <h1 className="text-lg font-medium leading-7">
            Telegram Bot Installed
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            Your bot is ready to use. Open it in Telegram to start chatting.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {botUsername && (
          <Button className="w-full" asChild>
            <a
              href={`tg://resolve?domain=${botUsername}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Telegram
            </a>
          </Button>
        )}
        <Button className="w-full" variant="outline" onClick={onGoToSettings}>
          Go to Settings
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function TelegramConnectPage() {
  const status = useGet(telegramConnectStatus$);
  const step = useGet(telegramConnectStep$);
  const isLinked = useGet(telegramConnectIsLinked$);
  const installation = useGet(telegramConnectInstallation$);
  const connectParams = useGet(telegramConnectParams$);
  const error = useGet(telegramConnectError$);
  const domainConfigured = useGet(telegramConnectDomainConfigured$);
  const botUsername = useGet(telegramConnectBotUsername$);
  const botId = useGet(telegramConnectBotId$);
  const theme = useGet(theme$);
  const registerBot = useSet(registerTelegramBot$);
  const linkBot = useSet(linkTelegramBot$);
  const navigate = useSet(navigateInReact$);
  const botToken = useGet(telegramBotToken$);
  const setBotToken = useSet(setTelegramBotToken$);
  const skip = useSet(skipTelegramConnect$);
  const openPopup = useSet(openTelegramConnectLoginPopup$);
  const copyStatus = useGet(copyStatus$);
  const copyToClipboard = useSet(copyToClipboard$);

  const handleRegister = () => {
    if (!botToken.trim()) {
      return;
    }
    detach(registerBot({ botToken: botToken.trim() }), Reason.DomCallback);
  };

  const handleLink = () => {
    if (!installation || !connectParams) {
      return;
    }
    detach(
      (async () => {
        const result = await linkBot({
          installationId: installation.id,
          ...connectParams,
        });
        if (result.success) {
          const successParams = new URLSearchParams();
          successParams.set("bot", result.botUsername);
          navigate("/telegram/connect/success", {
            searchParams: successParams,
          });
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleCancel = () => {
    navigate("/settings", {
      searchParams: new URLSearchParams({ tab: "integrations" }),
    });
  };

  const handleGoToSettings = () => {
    navigate("/settings/telegram");
  };

  const handleConnect = () => {
    if (botId) {
      openPopup(botId);
    }
  };

  const isLinking = status === "linking";

  const backgroundGradient =
    theme === "dark"
      ? "linear-gradient(91deg, rgba(255, 200, 176, 0.15) 0%, rgba(166, 222, 255, 0.15) 51%, rgba(255, 231, 162, 0.15) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)"
      : "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)";

  const renderContent = () => {
    if (status === "checking") {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">
            Checking installation status...
          </p>
        </div>
      );
    }

    if (isLinked) {
      return (
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col gap-1 text-center text-foreground">
            <h1 className="text-lg font-medium leading-7">Already Connected</h1>
            <p className="text-sm leading-5 text-muted-foreground">
              Your account is already linked to a Telegram bot.
            </p>
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              navigate("/settings", {
                searchParams: new URLSearchParams({
                  tab: "integrations",
                }),
              })
            }
          >
            Go to Settings
          </Button>
        </div>
      );
    }

    // Link account via signed connect params (from /connect command)
    if (installation && connectParams) {
      return (
        <>
          <div className="flex flex-col gap-1 text-center text-foreground">
            <h1 className="text-lg font-medium leading-7">Link Your Account</h1>
            <p className="text-sm leading-5 text-muted-foreground">
              Link your VM0 account to Telegram bot{" "}
              <span className="font-medium text-foreground">
                @{installation.botUsername}
              </span>
              {" to start using it."}
            </p>
          </div>

          {error && (
            <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-4">
            <Button
              onClick={handleLink}
              disabled={isLinking}
              className="w-full"
            >
              {isLinking ? "Linking..." : "Link Account"}
            </Button>
            <Button
              className="w-full"
              variant="outline"
              onClick={handleCancel}
              disabled={isLinking}
            >
              Cancel
            </Button>
          </div>
        </>
      );
    }

    // 3-step wizard: install -> connect-account -> complete
    if (step === "complete") {
      return (
        <CompleteStep
          botUsername={botUsername}
          onGoToSettings={handleGoToSettings}
        />
      );
    }

    if (step === "connect-account") {
      return (
        <ConnectAccountStep
          domainConfigured={domainConfigured}
          botId={botId}
          copyStatus={copyStatus}
          status={status}
          error={error}
          onConnect={handleConnect}
          onSkip={skip}
          onCopyDomain={() => {
            detach(
              copyToClipboard(window.location.hostname),
              Reason.DomCallback,
            );
          }}
        />
      );
    }

    // Default: install step
    return (
      <InstallStep
        botToken={botToken}
        status={status}
        error={error}
        onTokenChange={setBotToken}
        onRegister={handleRegister}
        onCancel={handleCancel}
      />
    );
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{ backgroundImage: backgroundGradient }}
    >
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-popover p-10">
        <div className="flex flex-col items-center gap-8">
          {/* Logo */}
          <div className="flex items-center gap-2.5 p-1.5">
            <img
              src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
              alt="VM0"
              className="h-5 w-auto"
            />
            <span className="text-2xl font-normal leading-8 text-foreground">
              Platform
            </span>
          </div>

          {/* Content */}
          <div className="flex w-full flex-col gap-6">{renderContent()}</div>
        </div>
      </div>
    </div>
  );
}
