import { useGet, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  slackIntegrationLoading$,
  slackIntegrationNotLinked$,
  slackInstallUrl$,
} from "../../signals/integrations-page/slack-integration.ts";
import { navigateInReact$ } from "../../signals/route.ts";

export function SlackIntegrationCard() {
  const loading = useGet(slackIntegrationLoading$);
  const notLinked = useGet(slackIntegrationNotLinked$);
  const installUrl = useGet(slackInstallUrl$);
  const navigate = useSet(navigateInReact$);

  if (loading) {
    return (
      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded" />
            <div>
              <Skeleton className="h-4 w-24 mb-1.5" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <img src="/slack-icon.svg" alt="Slack" className="h-9 w-9" />
          <div>
            <p className="text-sm font-medium">VM0 in Slack</p>
            <p className="text-sm text-muted-foreground">
              Use your VM0 agent in Slack
            </p>
          </div>
        </div>
        {notLinked ? (
          installUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={installUrl} target="_blank" rel="noopener noreferrer">
                Connect
              </a>
            </Button>
          ) : null
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/settings/slack")}
          >
            Settings
          </Button>
        )}
      </div>
    </div>
  );
}
