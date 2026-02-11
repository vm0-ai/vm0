import { useGet, useSet } from "ccstate-react";
import { Card } from "@vm0/ui/components/ui/card";
import { Button } from "@vm0/ui/components/ui/button";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { IconBrandSlack } from "@tabler/icons-react";
import { CheckCircle, AlertTriangle, ExternalLink } from "lucide-react";
import { AppShell } from "../layout/app-shell.tsx";
import {
  slackIntegrationData$,
  slackIntegrationLoading$,
  slackIntegrationError$,
  slackIntegrationNotLinked$,
} from "../../signals/integrations-page/slack-integration.ts";
import { navigateInReact$ } from "../../signals/route.ts";

export function IntegrationsPage() {
  return (
    <AppShell
      breadcrumb={["Integrations"]}
      title="Integrations"
      subtitle="Manage your connected services"
    >
      <div className="flex flex-col gap-5 px-4 sm:px-6 pb-8">
        <SlackIntegrationCard />
      </div>
    </AppShell>
  );
}

function SlackIntegrationCard() {
  const data = useGet(slackIntegrationData$);
  const loading = useGet(slackIntegrationLoading$);
  const error = useGet(slackIntegrationError$);
  const notLinked = useGet(slackIntegrationNotLinked$);

  if (loading) {
    return <SlackCardSkeleton />;
  }

  if (error) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <IconBrandSlack size={24} stroke={1.5} />
          <h3 className="text-lg font-medium">Slack</h3>
        </div>
        <p className="text-sm text-destructive">Failed to load: {error}</p>
      </Card>
    );
  }

  if (notLinked || !data) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <IconBrandSlack size={24} stroke={1.5} />
          <h3 className="text-lg font-medium">Slack</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          No Slack workspace connected. Use{" "}
          <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">
            /vm0 connect
          </code>{" "}
          in Slack to link your account.
        </p>
      </Card>
    );
  }

  const { workspace, agent, environment } = data;
  const totalSecrets = environment.requiredSecrets.length;
  const configuredSecrets = totalSecrets - environment.missingSecrets.length;
  const totalVars = environment.requiredVars.length;
  const configuredVars = totalVars - environment.missingVars.length;
  const totalRequired = totalSecrets + totalVars;
  const totalConfigured = configuredSecrets + configuredVars;
  const allConfigured =
    totalRequired === 0 || totalConfigured === totalRequired;

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <IconBrandSlack size={24} stroke={1.5} />
          <h3 className="text-lg font-medium">Slack</h3>
        </div>
        <StatusBadge
          allConfigured={allConfigured}
          configured={totalConfigured}
          total={totalRequired}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Workspace</p>
          <p className="text-sm font-medium">
            {workspace.name ?? workspace.id}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">Agent</p>
          <p className="text-sm font-medium">
            {agent?.name ?? "No agent configured"}
          </p>
        </div>
      </div>

      {totalRequired > 0 && <ConfigureButton environment={environment} />}
    </Card>
  );
}

function StatusBadge({
  allConfigured,
  configured,
  total,
}: {
  allConfigured: boolean;
  configured: number;
  total: number;
}) {
  if (total === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
        No secrets required
      </span>
    );
  }

  if (allConfigured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-secondary-foreground">
        <CheckCircle className="h-3 w-3 text-green-600" />
        All configured
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-secondary-foreground">
      <AlertTriangle className="h-3 w-3 text-amber-500" />
      {configured} of {total} configured
    </span>
  );
}

function ConfigureButton({
  environment,
}: {
  environment: {
    missingSecrets: string[];
    missingVars: string[];
  };
}) {
  const navigate = useSet(navigateInReact$);

  const handleClick = () => {
    const params = new URLSearchParams();
    if (environment.missingSecrets.length > 0) {
      params.set("secrets", environment.missingSecrets.join(","));
    }
    if (environment.missingVars.length > 0) {
      params.set("vars", environment.missingVars.join(","));
    }
    navigate("/environment-variables-setup", { searchParams: params });
  };

  return (
    <Button variant="outline" size="sm" onClick={handleClick}>
      <ExternalLink className="h-4 w-4" />
      Configure Environment
    </Button>
  );
}

function SlackCardSkeleton() {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Skeleton className="h-6 w-6 rounded" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <div>
          <Skeleton className="h-3 w-16 mb-2" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div>
          <Skeleton className="h-3 w-10 mb-2" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <Skeleton className="h-8 w-40" />
    </Card>
  );
}
