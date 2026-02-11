import { useGet, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Check } from "lucide-react";
import { theme$ } from "../../signals/theme.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import {
  slackLinkStatus$,
  slackLinkIsLinked$,
  slackLinkWorkspaceName$,
  slackLinkError$,
  slackLinkParams$,
  performSlackLink$,
} from "../../signals/slack-link/slack-link.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SlackLinkPage() {
  const status = useGet(slackLinkStatus$);
  const isLinked = useGet(slackLinkIsLinked$);
  const workspaceName = useGet(slackLinkWorkspaceName$);
  const error = useGet(slackLinkError$);
  const params = useGet(slackLinkParams$);
  const theme = useGet(theme$);
  const performLink = useSet(performSlackLink$);
  const navigate = useSet(navigateInReact$);

  const handleLink = () => {
    detach(
      (async () => {
        const result = (await performLink()) as {
          success: boolean;
          workspaceId?: string;
          channelId?: string | null;
          hasProvider?: boolean;
        };
        if (!result.success) {
          return;
        }

        if (!result.hasProvider) {
          const returnParams = new URLSearchParams();
          returnParams.set(
            "return",
            buildSuccessPath(result.workspaceId, result.channelId),
          );
          navigate("/provider-setup", { searchParams: returnParams });
        } else {
          const successParams = buildSuccessSearchParams(
            result.workspaceId,
            result.channelId,
          );
          navigate("/slack/link/success", { searchParams: successParams });
        }
      })(),
      Reason.DomCallback,
    );
  };

  // Missing required params
  if (!params.slackUserId || !params.workspaceId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-col items-center gap-6 p-10">
            <div className="rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive">
              Invalid link. Missing required parameters.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const backgroundGradient =
    theme === "dark"
      ? "linear-gradient(91deg, rgba(255, 200, 176, 0.15) 0%, rgba(166, 222, 255, 0.15) 51%, rgba(255, 231, 162, 0.15) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)"
      : "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)";

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{ backgroundImage: backgroundGradient }}
    >
      <div className="relative z-10 w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center gap-8 p-10">
          {/* Header with Logo */}
          <div className="flex items-center gap-2">
            <img
              src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
              alt="VM0"
              className="h-[20px] w-auto"
            />
            <span className="text-2xl text-foreground">+ Slack</span>
          </div>

          {status === "checking" ? (
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">
                Checking link status...
              </p>
            </div>
          ) : isLinked ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-500/10">
                <Check className="h-6 w-6 text-lime-600" />
              </div>
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-lg font-medium leading-7 text-foreground">
                  Already Linked
                </h1>
                <p className="text-sm leading-5 text-muted-foreground">
                  Your Slack account is already connected to VM0
                  {workspaceName && ` in ${workspaceName}`}.
                </p>
              </div>
              <Button
                onClick={handleLink}
                disabled={status === "linking"}
                className="mt-2 w-full"
              >
                {status === "linking" ? "Continuing..." : "Continue"}
              </Button>
            </div>
          ) : (
            <>
              {/* Title and Description */}
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-lg font-medium leading-7 text-foreground">
                  Link Your Slack Account
                </h1>
                <p className="text-sm leading-5 text-muted-foreground">
                  Connect your Slack account to interact with VM0 agents
                  directly from Slack.
                </p>
              </div>

              {/* Error Message */}
              {error && (
                <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
                  {error}
                </div>
              )}

              {/* Link Button */}
              <div className="w-full">
                <Button
                  onClick={handleLink}
                  disabled={status === "linking"}
                  className="w-full"
                >
                  {status === "linking" ? "Linking..." : "Link Slack Account"}
                </Button>

                <p className="mt-3 text-center text-xs text-muted-foreground">
                  This will allow VM0 to respond to your messages in Slack.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function buildSuccessPath(
  workspaceId?: string,
  channelId?: string | null,
): string {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("w", workspaceId);
  }
  if (channelId) {
    params.set("c", channelId);
  }
  const qs = params.toString();
  return `/slack/link/success${qs ? `?${qs}` : ""}`;
}

function buildSuccessSearchParams(
  workspaceId?: string,
  channelId?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (workspaceId) {
    params.set("w", workspaceId);
  }
  if (channelId) {
    params.set("c", channelId);
  }
  return params;
}
