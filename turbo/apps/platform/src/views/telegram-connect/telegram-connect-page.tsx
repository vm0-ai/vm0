import { useGet, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { theme$ } from "../../signals/theme.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import {
  telegramConnectStatus$,
  telegramConnectIsLinked$,
  telegramConnectError$,
  telegramBotToken$,
  setTelegramBotToken$,
  registerTelegramBot$,
} from "../../signals/telegram-connect/telegram-connect.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function TelegramConnectPage() {
  const status = useGet(telegramConnectStatus$);
  const isLinked = useGet(telegramConnectIsLinked$);
  const error = useGet(telegramConnectError$);
  const theme = useGet(theme$);
  const registerBot = useSet(registerTelegramBot$);
  const navigate = useSet(navigateInReact$);
  const botToken = useGet(telegramBotToken$);
  const setBotToken = useSet(setTelegramBotToken$);

  const handleRegister = () => {
    if (!botToken.trim()) {
      return;
    }
    detach(
      (async () => {
        const result = await registerBot({ botToken: botToken.trim() });
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

  const backgroundGradient =
    theme === "dark"
      ? "linear-gradient(91deg, rgba(255, 200, 176, 0.15) 0%, rgba(166, 222, 255, 0.15) 51%, rgba(255, 231, 162, 0.15) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)"
      : "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)";

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
          <div className="flex w-full flex-col gap-6">
            {status === "checking" ? (
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <p className="text-sm text-muted-foreground">
                  Checking connection status...
                </p>
              </div>
            ) : isLinked ? (
              /* Already linked */
              <div className="flex flex-col items-center gap-4">
                <div className="flex flex-col gap-1 text-center text-foreground">
                  <h1 className="text-lg font-medium leading-7">
                    Already Connected
                  </h1>
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
            ) : (
              /* Registration form */
              <>
                <div className="flex flex-col gap-1 text-center text-foreground">
                  <h1 className="text-lg font-medium leading-7">
                    Connect a Telegram Bot
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
                    to connect your Telegram bot to VM0.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Input
                    type="password"
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleRegister();
                      }
                    }}
                  />
                </div>

                {/* Error Message */}
                {error && (
                  <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
                    {error}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-col gap-4">
                  <Button
                    onClick={handleRegister}
                    disabled={!botToken.trim() || status === "registering"}
                    className="w-full"
                  >
                    {status === "registering"
                      ? "Registering..."
                      : "Connect Bot"}
                  </Button>
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() =>
                      navigate("/settings", {
                        searchParams: new URLSearchParams({
                          tab: "integrations",
                        }),
                      })
                    }
                    disabled={status === "registering"}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
