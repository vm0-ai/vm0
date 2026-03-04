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
  githubIntegrationPendingApproval$,
} from "../../signals/integrations-page/github-integration.ts";
import githubIcon from "../settings-page/icons/github.svg";
import { Link } from "../router/link.tsx";

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
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/50">
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
  const pendingApproval = useGet(githubIntegrationPendingApproval$);

  if (loading) {
    return <IntegrationCardSkeleton />;
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="shrink-0">
        <img src={githubIcon} alt="GitHub" className="h-7 w-7" />
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">VM0 in GitHub</div>
        <div className="text-sm text-muted-foreground">
          Use your VM0 agent in GitHub
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
        ) : pendingApproval ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
              Pending Approval
            </span>
            <Button variant="outline" size="sm" asChild>
              <Link pathname="/settings/github">Settings</Link>
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Installed
          </Button>
        )}
      </div>
    </div>
  );
}
