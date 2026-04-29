// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconArrowLeft,
  IconCpu,
  IconDotsVertical,
  IconPlus,
} from "@tabler/icons-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import {
  MODEL_PROVIDER_TYPES,
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import type {
  ModelUsageRankingDailyBucket,
  ModelUsageRankingItem,
  ModelUsageRankingRange,
  ModelUsageRankingResponse,
} from "@vm0/api-contracts/contracts/zero-model-usage-ranking";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  cn,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import {
  modelUsageRankingEnabled$,
  modelUsageRankingAsync$,
  modelUsageRankingOpen$,
  modelUsageRankingRange$,
  setModelUsageRankingOpen$,
  setModelUsageRankingRange$,
} from "../../../../signals/model-usage-ranking.ts";
import {
  orgAddProviderDialogOpen$,
  setOrgAddProviderDialogOpen$,
  orgConfiguredProviders$,
  orgDefaultProvider$,
  orgSetDefaultProvider$,
  orgOpenEditDialog$,
  orgOpenDeleteDialog$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { getUILabel } from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { OrgAddProviderDialog } from "../settings/org-add-provider-dialog.tsx";
import { OrgProviderDialog } from "../settings/org-provider-dialog.tsx";
import { OrgDeleteProviderDialog } from "../settings/org-delete-provider-dialog.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

export function OrgProvidersTab() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const rankingOpen = useGet(modelUsageRankingOpen$);
  const setRankingOpen = useSet(setModelUsageRankingOpen$);
  const rankingEnabledLoadable = useLoadable(modelUsageRankingEnabled$);
  const rankingEnabled =
    rankingEnabledLoadable.state === "hasData"
      ? rankingEnabledLoadable.data
      : false;

  if (rankingOpen && rankingEnabled) {
    return (
      <ModelUsageRankingSection
        onBack={() => {
          return setRankingOpen(false);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {isAdmin && <DefaultProviderSection />}
      <ProviderListSection isAdmin={isAdmin} />
      <OrgDeleteProviderDialog />
      <OrgProviderDialog />
    </div>
  );
}

function DefaultProviderSection() {
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const defaultProviderLoadable = useLoadable(orgDefaultProvider$);
  const setDefault = useSet(orgSetDefaultProvider$);
  const pageSignal = useGet(pageSignal$);

  const isLoading =
    providersLoadable.state === "loading" ||
    defaultProviderLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const defaultProvider =
    defaultProviderLoadable.state === "hasData"
      ? defaultProviderLoadable.data
      : null;

  const selectItems = providers.map((p) => {
    return {
      type: p.type,
      label: getUILabel(p.type),
    };
  });
  const currentDefault = defaultProvider?.type ?? selectItems[0]?.type ?? "";

  const handleChange = (value: string) => {
    if (providers.length > 0) {
      detach(
        setDefault(value as ModelProviderType, pageSignal),
        Reason.DomCallback,
      );
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Default</h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Default provider
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Applied to all tasks across schedule, Slack, and web.
            </p>
          </div>
          {isLoading ? (
            <div className="w-[220px] h-9 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
          ) : selectItems.length === 0 ? (
            <span className="text-sm text-muted-foreground shrink-0">
              No providers configured
            </span>
          ) : (
            <Select value={currentDefault} onValueChange={handleChange}>
              <SelectTrigger
                className="w-[280px] h-9 shrink-0 rounded-lg"
                style={{ border: "0.7px solid hsl(var(--gray-400))" }}
              >
                <SelectValue placeholder="Select a default provider" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((item) => {
                  return (
                    <SelectItem key={item.type} value={item.type}>
                      <div className="flex items-center gap-2">
                        <ProviderIcon type={item.type} size={16} />
                        <span>{item.label}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderListSection({ isAdmin }: { isAdmin: boolean }) {
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const addDialogOpen = useGet(orgAddProviderDialogOpen$);
  const setAddDialogOpen = useSet(setOrgAddProviderDialogOpen$);
  const openEdit = useSet(orgOpenEditDialog$);
  const openDelete = useSet(orgOpenDeleteDialog$);

  const isLoading = providersLoadable.state === "loading";
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const totalProviderTypes = Object.keys(MODEL_PROVIDER_TYPES).length;
  const allConfigured = !isLoading && providers.length >= totalProviderTypes;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Model providers</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {isAdmin && !allConfigured && (
          <button
            type="button"
            onClick={() => {
              return setAddDialogOpen(true);
            }}
            className="flex flex-col overflow-hidden transition-colors hover:bg-muted/30 group zero-border-dashed rounded-xl"
          >
            <div className="flex h-14 items-center gap-2.5 px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <IconPlus
                  size={18}
                  stroke={2}
                  className="text-muted-foreground group-hover:text-foreground"
                />
              </span>
              <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">
                Add provider
              </span>
            </div>
            <div className="flex h-11 items-center px-5 zero-border-dashed-t">
              <span className="text-xs text-muted-foreground/70">
                Browse supported providers
              </span>
            </div>
          </button>
        )}

        {isLoading && (
          <>
            <ProviderSkeleton />
            <ProviderSkeleton />
          </>
        )}

        {!isLoading &&
          providers.map((p) => {
            return (
              <div
                key={p.type}
                role={isAdmin ? "button" : undefined}
                tabIndex={isAdmin ? 0 : undefined}
                onClick={
                  isAdmin
                    ? () => {
                        return openEdit(p);
                      }
                    : undefined
                }
                onKeyDown={
                  isAdmin
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openEdit(p);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "overflow-hidden zero-card shadow-[var(--zero-card-shadow)]",
                  isAdmin && "cursor-pointer",
                )}
              >
                <div className="flex h-14 items-center gap-2.5 px-5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    <ProviderIcon type={p.type} size={22} />
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                    {getUILabel(p.type)}
                  </span>
                </div>
                <div
                  className="flex h-11 items-center justify-between pl-5 pr-2 zero-border-t"
                  onClick={
                    isAdmin
                      ? (e) => {
                          return e.stopPropagation();
                        }
                      : undefined
                  }
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    Configured
                  </span>
                  {isAdmin && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                          aria-label="More options"
                        >
                          <IconDotsVertical size={14} stroke={1.5} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          onClick={() => {
                            return openEdit(p);
                          }}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => {
                            return openDelete(p.type);
                          }}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            );
          })}

        {!isLoading && !isAdmin && providers.length === 0 && (
          <div className="col-span-full text-center py-8">
            <p className="text-sm text-muted-foreground">
              No providers configured yet. Contact your admin.
            </p>
          </div>
        )}
      </div>

      {isAdmin && (
        <OrgAddProviderDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
        />
      )}
    </div>
  );
}

function ModelUsageRankingSection({ onBack }: { onBack: () => void }) {
  const range = useGet(modelUsageRankingRange$);
  const setRange = useSet(setModelUsageRankingRange$);
  const rankingLoadable = useLoadable(modelUsageRankingAsync$);
  const data =
    rankingLoadable.state === "hasData" ? rankingLoadable.data : null;
  const models = data?.models ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 h-8 gap-1.5 rounded-lg px-2 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <IconArrowLeft size={14} stroke={1.5} />
          Model providers
        </Button>
        <Tabs
          value={range}
          onValueChange={(value) => {
            return setRange(value as ModelUsageRankingRange);
          }}
        >
          <TabsList className="zero-tabs h-8 gap-1 px-1 py-1">
            <TabsTrigger value="1d" className="h-6 px-2.5 text-xs">
              1D
            </TabsTrigger>
            <TabsTrigger value="7d" className="h-6 px-2.5 text-xs">
              7D
            </TabsTrigger>
            <TabsTrigger value="30d" className="h-6 px-2.5 text-xs">
              30D
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {rankingLoadable.state === "loading" && <RankingSkeleton />}

      {rankingLoadable.state === "hasError" && (
        <RankingStatePanel>
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            Could not load model ranking.
          </p>
        </RankingStatePanel>
      )}

      {rankingLoadable.state === "hasData" && models.length === 0 && (
        <RankingStatePanel>
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No model usage yet.
          </p>
        </RankingStatePanel>
      )}

      {rankingLoadable.state === "hasData" && data && models.length > 0 && (
        <ModelPopularityDashboard data={data} />
      )}
    </section>
  );
}

interface TrendSeries {
  key: string;
  model: string;
  color: string;
}

type TrendDatum = {
  date: string;
  label: string;
} & Record<string, number | string>;

function ModelPopularityDashboard({
  data,
}: {
  data: ModelUsageRankingResponse;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)]">
      <TopModelsTrendPanel data={data} />
      <ModelLeaderboardPanel models={data.models} />
    </div>
  );
}

function TopModelsTrendPanel({ data }: { data: ModelUsageRankingResponse }) {
  const { rows, series } = buildTrendChartData(data.daily, data.models);
  return (
    <section
      className="min-w-0 rounded-xl bg-card p-5"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
    >
      <div className="min-w-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Top Models</h3>
          <p className="mt-1 truncate whitespace-nowrap text-[13px] text-muted-foreground">
            Daily model popularity across VM0
          </p>
        </div>
      </div>

      <div
        className="mt-5 h-[300px] min-w-0 [&_.recharts-surface]:outline-none [&_.recharts-surface:focus]:outline-none [&_.recharts-surface:focus-visible]:outline-none [&_.recharts-wrapper]:outline-none [&_.recharts-wrapper:focus]:outline-none"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            accessibilityLayer={false}
            margin={{ top: 12, right: 16, bottom: 4, left: 4 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="hsl(var(--border))"
              strokeDasharray="3 3"
              opacity={0.75}
            />
            <XAxis
              dataKey="label"
              minTickGap={28}
              axisLine={false}
              tickLine={false}
              tick={{
                fill: "hsl(var(--muted-foreground))",
                fontSize: 11,
                fontWeight: 500,
              }}
              tickMargin={10}
            />
            <YAxis
              width={52}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatRankingTokens}
              tick={{
                fill: "hsl(var(--muted-foreground))",
                fontSize: 11,
                fontWeight: 500,
              }}
              tickMargin={8}
            />
            <RechartsTooltip
              cursor={{
                stroke: "hsl(var(--muted-foreground) / 0.35)",
                strokeDasharray: "4 4",
              }}
              content={renderTrendTooltip}
            />
            {series.map((item) => {
              return (
                <Line
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  name={getModelDisplayName(item.model)}
                  stroke={item.color}
                  strokeWidth={2.25}
                  dot={data.daily.length <= 1 ? { r: 3 } : false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function ModelLeaderboardPanel({
  models,
}: {
  models: ModelUsageRankingItem[];
}) {
  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl bg-card"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
    >
      <div className="px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            LLM Leaderboard
          </h3>
          <p className="mt-1 truncate whitespace-nowrap text-[13px] text-muted-foreground">
            Compare the most popular models on VM0
          </p>
        </div>
      </div>
      <ol className="divide-y divide-border/60">
        {models.map((item, index) => {
          return (
            <LeaderboardRow key={item.model} item={item} rank={index + 1} />
          );
        })}
      </ol>
    </section>
  );
}

function LeaderboardRow({
  item,
  rank,
}: {
  item: ModelUsageRankingItem;
  rank: number;
}) {
  const providerType = resolveRankingProviderType(item.model);
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3.5">
      <span className="text-sm font-semibold tabular-nums text-muted-foreground">
        {rank}.
      </span>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          {providerType ? (
            <ProviderIcon type={providerType} size={22} />
          ) : (
            <IconCpu size={17} stroke={1.5} className="text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {getModelDisplayName(item.model)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            by {getRankingVendorLabel(item.model)}
          </div>
        </div>
      </div>
      <div className="min-w-[5.5rem] text-right">
        <div className="text-sm font-semibold tabular-nums text-foreground">
          {formatRankingTokens(item.totalTokens)}
        </div>
        <div className="mt-0.5 flex items-center justify-end text-xs">
          <RankingChangeBadge item={item} />
        </div>
      </div>
    </li>
  );
}

function RankingChangeBadge({ item }: { item: ModelUsageRankingItem }) {
  if (item.changePercent === null) {
    return (
      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-600">
        new
      </span>
    );
  }
  const isPositive = item.changePercent > 0;
  const isNegative = item.changePercent < 0;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 font-medium tabular-nums",
        isPositive && "bg-emerald-500/10 text-emerald-600",
        isNegative && "bg-destructive/10 text-destructive",
        !isPositive && !isNegative && "bg-muted text-muted-foreground",
      )}
    >
      {isPositive ? "+" : ""}
      {formatRankingPercent(item.changePercent)}
    </span>
  );
}

function renderTrendTooltip(props: TooltipContentProps) {
  return <TrendTooltip {...props} />;
}

function TrendTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const rows = payload
    .map((entry) => {
      return {
        name: String(entry.name ?? ""),
        color: entry.color,
        value: Number(entry.value ?? 0),
      };
    })
    .filter((entry) => {
      return entry.value > 0;
    });
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-foreground">{String(label)}</div>
      <div className="mt-1.5 space-y-1">
        {rows.map((entry) => {
          return (
            <div
              key={entry.name}
              className="flex min-w-44 items-center justify-between gap-4"
            >
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="truncate">{entry.name}</span>
              </span>
              <span className="font-medium tabular-nums text-foreground">
                {formatRankingTokens(entry.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildTrendChartData(
  daily: ModelUsageRankingDailyBucket[],
  models: ModelUsageRankingItem[],
): { rows: TrendDatum[]; series: TrendSeries[] } {
  const series = models.slice(0, 5).map((item, index) => {
    return {
      key: `model_${index}`,
      model: item.model,
      color: rankingBarColor(index),
    };
  });
  const rows = daily.map((bucket) => {
    const row: TrendDatum = {
      date: bucket.date,
      label: formatDailyTick(bucket.date),
    };
    for (const item of series) {
      const model = bucket.models.find((entry) => {
        return entry.model === item.model;
      });
      row[item.key] = model?.totalTokens ?? 0;
    }
    return row;
  });
  return { rows, series };
}

function RankingSkeleton() {
  return (
    <RankingStatePanel>
      <div className="divide-y divide-border/60">
        <div className="px-4 py-3.5">
          <RankingSkeletonRow widthClassName="w-4/5" />
        </div>
        <div className="px-4 py-3.5">
          <RankingSkeletonRow widthClassName="w-3/5" />
        </div>
        <div className="px-4 py-3.5">
          <RankingSkeletonRow widthClassName="w-2/5" />
        </div>
      </div>
    </RankingStatePanel>
  );
}

function RankingStatePanel({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-xl bg-card"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
    >
      {children}
    </div>
  );
}

function RankingSkeletonRow({ widthClassName }: { widthClassName: string }) {
  return (
    <div className="flex items-center gap-3 animate-pulse">
      <span className="h-4 w-6 rounded bg-muted/60" />
      <span className="h-9 w-9 rounded-lg bg-muted/60" />
      <div className="min-w-0 flex-1 space-y-2">
        <span className="block h-4 w-36 rounded bg-muted/60" />
        <span
          className={cn("block h-2 rounded-full bg-muted", widthClassName)}
        />
      </div>
      <span className="h-4 w-12 rounded bg-muted/60" />
    </div>
  );
}

function resolveRankingProviderType(
  model: string,
): ModelProviderType | undefined {
  const entry = VM0_MODEL_TO_PROVIDER[model];
  return entry?.concreteType as ModelProviderType | undefined;
}

function getRankingVendorLabel(model: string): string {
  const entry = VM0_MODEL_TO_PROVIDER[model];
  if (entry?.vendor) {
    return entry.vendor;
  }
  if (model.includes("/")) {
    return model.split("/")[0] ?? "vm0";
  }
  return "vm0";
}

function formatDailyTick(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function rankingBarColor(index: number): string {
  switch (index % 6) {
    case 0: {
      return "hsl(var(--primary))";
    }
    case 1: {
      return "hsl(var(--chart-2, 173 58% 39%))";
    }
    case 2: {
      return "hsl(var(--chart-3, 197 37% 24%))";
    }
    case 3: {
      return "hsl(var(--chart-4, 43 74% 66%))";
    }
    case 4: {
      return "hsl(var(--chart-5, 27 87% 67%))";
    }
    default: {
      return "hsl(var(--muted-foreground))";
    }
  }
}

function formatRankingTokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatRankingPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function ProviderSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden bg-card animate-pulse zero-border rounded-xl">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
        <span className="h-4 w-24 rounded bg-muted/50" />
      </div>
      <div className="flex h-11 items-center px-5 zero-border-t">
        <span className="h-3 w-16 rounded bg-muted/30" />
      </div>
    </div>
  );
}
