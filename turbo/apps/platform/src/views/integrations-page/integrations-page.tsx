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
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
        <div className="shrink-0">
          <Skeleton className="h-7 w-7 rounded" />
        </div>
        <div className="flex flex-1 flex-col gap-2 min-w-0">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-8 w-16 shrink-0" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
      <div className="shrink-0">
        <img src="/slack-icon.svg" alt="Slack" className="h-7 w-7" />
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">VM0 in Slack</div>
        <div className="text-sm text-muted-foreground">
          Use your VM0 agent in Slack
        </div>
      </div>
      <div className="shrink-0">
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
