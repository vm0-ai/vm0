import { useLoadable, useGet, useSet } from "ccstate-react";
import {
  usageMembersAsync$,
  usageTab$,
  setUsageTab$,
  type UsageTab,
} from "../../signals/usage-page/usage-signals.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { CreditsChart } from "./components/credits-chart.tsx";
import { RunsTab } from "./components/runs-tab.tsx";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-6 w-48 animate-pulse bg-muted/20 rounded" />
      <div className="zero-card h-64 animate-pulse bg-muted/20" />
    </div>
  );
}

function EmptyState({ message, testId }: { message: string; testId: string }) {
  return (
    <div
      className="zero-card flex items-center justify-center p-12"
      data-testid={testId}
    >
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function MembersTable() {
  const loadable = useLoadable(usageMembersAsync$);

  const isLoading = loadable.state === "loading";
  const hasError = loadable.state === "hasError";
  const data = loadable.state === "hasData" ? loadable.data : null;

  if (isLoading) {
    return <UsageSkeleton />;
  }
  if (hasError) {
    return (
      <EmptyState
        message="Failed to load usage data. Please try again later."
        testId="usage-page-error"
      />
    );
  }
  if (!data?.period) {
    return (
      <EmptyState
        message="No active billing period. Usage tracking is available for paid plans."
        testId="usage-page-no-period"
      />
    );
  }
  if (data.members.length === 0) {
    return (
      <EmptyState
        message="No usage recorded in this billing period."
        testId="usage-page-no-members"
      />
    );
  }

  return (
    <div className="zero-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Member
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Input Tokens
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Output Tokens
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Cache Tokens
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Credits
            </th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((member) => {
            return (
              <tr
                key={member.userId}
                className="border-b border-border last:border-0 hover:bg-muted/10"
              >
                <td className="px-4 py-3 text-foreground">{member.email}</td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {formatNumber(member.inputTokens)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {formatNumber(member.outputTokens)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-foreground">
                  {formatNumber(
                    member.cacheReadInputTokens +
                      member.cacheCreationInputTokens,
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums font-medium text-foreground">
                  {formatNumber(member.creditsCharged)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab() {
  return (
    <div className="flex flex-col gap-6">
      <CreditsChart />
      <MembersTable />
    </div>
  );
}

function AdminUsagePage() {
  const tab = useGet(usageTab$);
  const setTab = useSet(setUsageTab$);
  const loadable = useLoadable(usageMembersAsync$);
  const data = loadable.state === "hasData" ? loadable.data : null;

  const handleTabChange = (value: string) => {
    setTab(value as UsageTab);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Usage
          </h1>
          {data?.period ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatDate(data.period.start)} &ndash;{" "}
              {formatDate(data.period.end)}
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-muted-foreground">
              Per-member credit consumption in the current billing period.
            </p>
          )}
        </div>
      </header>

      <div className="shrink-0 px-4 sm:px-6 pb-4">
        <div className="mx-auto max-w-[900px]">
          <Tabs value={tab} onValueChange={handleTabChange}>
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="overview"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="runs"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Runs
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-0 pb-8">
        <div className="mx-auto max-w-[900px]">
          {tab === "overview" && <OverviewTab />}
          {tab === "runs" && <RunsTab />}
        </div>
      </main>
    </div>
  );
}

function MemberUsagePage() {
  const loadable = useLoadable(usageMembersAsync$);

  const isLoading = loadable.state === "loading";
  const hasError = loadable.state === "hasError";
  const data = loadable.state === "hasData" ? loadable.data : null;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Usage
          </h1>
          {data?.period ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {formatDate(data.period.start)} &ndash;{" "}
              {formatDate(data.period.end)}
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-muted-foreground">
              Per-member credit consumption in the current billing period.
            </p>
          )}
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          {isLoading ? (
            <UsageSkeleton />
          ) : hasError ? (
            <EmptyState
              message="Failed to load usage data. Please try again later."
              testId="usage-page-error"
            />
          ) : !data?.period ? (
            <EmptyState
              message="No active billing period. Usage tracking is available for paid plans."
              testId="usage-page-no-period"
            />
          ) : data.members.length === 0 ? (
            <EmptyState
              message="No usage recorded in this billing period."
              testId="usage-page-no-members"
            />
          ) : (
            <MembersTable />
          )}
        </div>
      </main>
    </div>
  );
}

export function UsagePage() {
  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    adminLoadable.state === "hasData" ? adminLoadable.data : false;

  if (isAdmin) {
    return <AdminUsagePage />;
  }

  return <MemberUsagePage />;
}
