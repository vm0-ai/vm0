import { useGet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Check } from "lucide-react";
import { theme$ } from "../../signals/theme.ts";
import { searchParams$ } from "../../signals/route.ts";

export function TelegramConnectSuccessPage() {
  const theme = useGet(theme$);
  const params = useGet(searchParams$);

  const botUsername = params.get("bot");
  const telegramLink = botUsername
    ? `tg://resolve?domain=${botUsername}`
    : null;

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
          <div className="flex w-full flex-col items-center gap-6">
            <div className="flex flex-col items-center gap-4">
              <Check size={24} className="text-lime-600" strokeWidth={2} />

              <div className="flex flex-col gap-1 text-center text-foreground">
                <h1 className="text-lg font-medium leading-7">
                  Telegram Bot Connected
                </h1>
                <p className="text-sm leading-5 text-muted-foreground">
                  Your account is linked. Open Telegram and send any message to
                  the bot to start chatting with the agent.
                </p>
              </div>
            </div>

            {/* Tip */}
            <p className="text-center text-xs leading-5 text-muted-foreground">
              Tip: The agent you&apos;re using may require authorization for
              certain apps or APIs. You can configure this in{" "}
              <a
                href="/settings/telegram"
                className="text-primary hover:underline"
              >
                VM0 Platform &gt; Settings
              </a>
              .
            </p>

            {/* Action Buttons */}
            <div className="flex w-full flex-col gap-4">
              {telegramLink && (
                <Button asChild variant="outline" className="w-full">
                  <a href={telegramLink}>Open in Telegram</a>
                </Button>
              )}
              <Button asChild variant="outline" className="w-full">
                <a href="/settings/telegram">Go to VM0 Platform</a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
