import { useGet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Check } from "lucide-react";
import { theme$ } from "../../signals/theme.ts";
import { searchParams$ } from "../../signals/route.ts";

export function SlackLinkSuccessPage() {
  const theme = useGet(theme$);
  const params = useGet(searchParams$);

  const workspaceId = params.get("w");
  const channelId = params.get("c");

  const slackDeepLink =
    workspaceId && channelId
      ? `slack://channel?team=${workspaceId}&id=${channelId}`
      : "slack://open";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px] min-h-[380px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center p-10">
          {/* Header with Logo */}
          <div className="flex items-center gap-2 mb-8">
            <img
              src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
              alt="VM0"
              className="h-[20px] w-auto"
            />
            <span className="text-2xl font-medium text-foreground">
              + Slack
            </span>
          </div>

          {/* Content */}
          <div className="mt-4 flex flex-col items-center gap-4">
            <Check size={40} className="text-lime-600" strokeWidth={1} />

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-lg font-medium leading-7 text-foreground">
                Account Linked Successfully
              </h1>
              <p className="text-sm leading-5 text-muted-foreground">
                Your Slack account is now connected to VM0. You can now interact
                with agents by mentioning @VM0 in Slack.
              </p>
            </div>

            {/* Open Slack Button */}
            <Button asChild className="mt-4 w-full">
              <a href={slackDeepLink} className="!text-primary-foreground">
                Open Slack
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.166 0a2.528 2.528 0 0 1 2.521 2.522v6.312zm-2.521 10.124a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.166 24a2.528 2.528 0 0 1-2.521-2.52v-2.522h2.521zm0-1.271a2.528 2.528 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.312A2.528 2.528 0 0 1 24 15.166a2.528 2.528 0 0 1-2.52 2.521h-6.313z" />
                </svg>
              </a>
            </Button>

            {/* Instructions */}
            <div className="mt-4 w-full rounded-lg bg-muted/50 p-4">
              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground">Next steps:</strong>
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                <li>
                  • Use{" "}
                  <code className="rounded bg-muted px-1">/vm0 agent link</code>{" "}
                  to link an agent
                </li>
                <li>
                  • Mention <code className="rounded bg-muted px-1">@VM0</code>{" "}
                  to chat with your agents
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
