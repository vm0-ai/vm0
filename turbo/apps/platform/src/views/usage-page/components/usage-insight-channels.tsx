import type { UsageInsightResponse } from "@vm0/core";
import type { InsightMetric } from "../../../signals/usage-page/usage-insight-signals.ts";

function formatValue(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function UsageInsightChannels({
  data,
  metric,
}: {
  data: UsageInsightResponse;
  metric: InsightMetric;
}) {
  const channels = [
    {
      label: "Email",
      credits: data.emailCredits,
      tokens: data.emailTokens,
    },
    {
      label: "Slack",
      credits: data.slackCredits,
      tokens: data.slackTokens,
    },
  ];

  const hasAnyData = channels.some((c) => {
    return metric === "credits" ? c.credits > 0 : c.tokens > 0;
  });
  if (!hasAnyData) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Channels</h3>
      <div className="overflow-hidden rounded-xl bg-card zero-border">
        {channels.map((channel, idx) => {
          return (
            <div key={channel.label}>
              {idx > 0 && <div className="h-0 zero-border-t mx-5" />}
              <div className="flex items-center justify-between px-5 py-3">
                <span className="text-sm text-foreground">{channel.label}</span>
                <span className="text-[13px] tabular-nums text-foreground">
                  {metric === "credits"
                    ? formatValue(channel.credits)
                    : formatValue(channel.tokens)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
