import { useGet, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Check } from "lucide-react";
import { theme$ } from "../../signals/theme.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import {
  slackConnectStatus$,
  slackConnectIsLinked$,
  slackConnectWorkspaceName$,
  slackConnectError$,
  slackConnectIsAdmin$,
  slackConnectDefaultAgent$,
  slackConnectAgents$,
  slackConnectSelectedAgentId$,
  performSlackConnect$,
  setSlackConnectAgent$,
} from "../../signals/slack-connect/slack-connect.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SlackConnectPage() {
  const status = useGet(slackConnectStatus$);
  const isLinked = useGet(slackConnectIsLinked$);
  const workspaceName = useGet(slackConnectWorkspaceName$);
  const error = useGet(slackConnectError$);
  const isAdmin = useGet(slackConnectIsAdmin$);
  const defaultAgent = useGet(slackConnectDefaultAgent$);
  const agents = useGet(slackConnectAgents$);
  const selectedAgentId = useGet(slackConnectSelectedAgentId$);
  const theme = useGet(theme$);
  const performConnect = useSet(performSlackConnect$);
  const setAgent = useSet(setSlackConnectAgent$);
  const navigate = useSet(navigateInReact$);

  const handleAuthorize = () => {
    detach(
      (async () => {
        const result = (await performConnect()) as {
          success: boolean;
          workspaceId?: string;
          channelId?: string | null;
        };
        if (!result.success) {
          return;
        }

        const successParams = buildSuccessSearchParams(
          result.workspaceId,
          result.channelId,
        );
        navigate("/slack/connect/success", { searchParams: successParams });
      })(),
      Reason.DomCallback,
    );
  };

  const handleDecline = () => {
    window.close();
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
            ) : status === "error" && !isLinked ? (
              <div className="rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive">
                {error ?? "Something went wrong."}
              </div>
            ) : isLinked ? (
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-500/10">
                  <Check className="h-6 w-6 text-lime-600" />
                </div>
                <div className="flex flex-col gap-1 text-center text-foreground">
                  <h1 className="text-lg font-medium leading-7">
                    Already Connected
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    Your Slack account is already connected to VM0
                    {workspaceName && ` in ${workspaceName}`}.
                  </p>
                </div>
                <Button
                  onClick={handleAuthorize}
                  disabled={status === "linking"}
                  className="w-full"
                >
                  {status === "linking" ? "Continuing..." : "Continue"}
                </Button>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex flex-col gap-1 text-center text-foreground">
                  <h1 className="text-lg font-medium leading-7">
                    VM0 for Slack would like to connect to your VM0 account
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    Your account will be used in the Slack for agent run and
                    automation. Select the agent in your VM0 platform
                  </p>
                </div>

                {/* Agent Selector */}
                {agents.length > 0 && (
                  <Select
                    value={selectedAgentId ?? defaultAgent?.id ?? ""}
                    onValueChange={setAgent}
                    disabled={!isAdmin}
                  >
                    <SelectTrigger className="w-[280px] self-center">
                      <SelectValue placeholder="Select agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {/* Error Message */}
                {error && (
                  <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
                    {error}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-col gap-4">
                  <Button
                    onClick={handleAuthorize}
                    disabled={status === "linking"}
                    className="w-full"
                  >
                    {status === "linking" ? "Authorizing..." : "Authorize"}
                  </Button>
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={handleDecline}
                    disabled={status === "linking"}
                  >
                    Decline
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
