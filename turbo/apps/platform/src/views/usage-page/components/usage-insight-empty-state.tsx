import emptyInsightsImg from "../../zero-page/assets/empty-insights.webp";

export function UsageInsightEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <img
        src={emptyInsightsImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="h-24 w-24 object-contain opacity-80"
      />
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">No usage data yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Start a chat or run a schedule to see your insights here.
        </p>
      </div>
    </div>
  );
}
