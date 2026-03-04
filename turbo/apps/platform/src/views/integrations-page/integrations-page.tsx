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
import {
  telegramIntegrationLoading$,
  telegramIntegrationNotLinked$,
} from "../../signals/integrations-page/telegram-integration.ts";
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
          <Button variant="outline" size="sm" asChild>
            <Link pathname="/settings/github">Settings</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function TelegramIntegrationCard() {
  const loading = useGet(telegramIntegrationLoading$);
  const notLinked = useGet(telegramIntegrationNotLinked$);

  if (loading) {
    return <IntegrationCardSkeleton />;
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="shrink-0">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          className="h-7 w-7"
          fill="currentColor"
        >
          <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
        </svg>
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">
          VM0 in Telegram
        </div>
        <div className="text-sm text-muted-foreground">
          Use your VM0 agent in Telegram
        </div>
      </div>
      <div className="shrink-0">
        {notLinked ? (
          <Button variant="outline" size="sm" asChild>
            <Link pathname="/telegram/connect">Install</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link pathname="/settings/telegram">Settings</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
