import { useGet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  slackIntegrationLoading$,
  slackIntegrationNotLinked$,
  slackInstallUrl$,
} from "../../signals/integrations-page/slack-integration.ts";
import {
  githubIntegrationLoading$,
  githubIntegrationNotLinked$,
  githubInstallUrl$,
} from "../../signals/integrations-page/github-integration.ts";
import { Link } from "../router/link.tsx";
import githubIcon from "../settings-page/icons/github.svg";

function IntegrationCardSkeleton() {
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

export function SlackIntegrationCard() {
  const loading = useGet(slackIntegrationLoading$);
  const notLinked = useGet(slackIntegrationNotLinked$);
  const installUrl = useGet(slackInstallUrl$);

  if (loading) {
    return <IntegrationCardSkeleton />;
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
                Install
              </a>
            </Button>
          ) : null
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link pathname="/settings/slack">Settings</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function GitHubIntegrationCard() {
  const loading = useGet(githubIntegrationLoading$);
  const notLinked = useGet(githubIntegrationNotLinked$);
  const installUrl = useGet(githubInstallUrl$);

  if (loading) {
    return <IntegrationCardSkeleton />;
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
      <div className="shrink-0">
        <img src={githubIcon} alt="GitHub" className="h-7 w-7" />
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">GitHub Issues</div>
        <div className="text-sm text-muted-foreground">
          Trigger agents from GitHub issue events
        </div>
      </div>
      <div className="shrink-0">
        {notLinked ? (
          installUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={installUrl} target="_blank" rel="noopener noreferrer">
                Install
              </a>
            </Button>
          ) : null
        ) : (
          <Button variant="outline" size="sm" disabled>
            Installed
          </Button>
        )}
      </div>
    </div>
  );
}
