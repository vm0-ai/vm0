const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

export function OrgCreditsTab() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Usage</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Credit balance
              </span>
              <span className="text-[13px] text-muted-foreground">
                Credits available for AI usage
              </span>
            </div>
            <span className="text-lg font-semibold text-foreground tabular-nums shrink-0">
              0
            </span>
          </div>
          <div className="h-px bg-border/40 mx-5" />
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Usage this month
              </span>
              <span className="text-[13px] text-muted-foreground">
                Total credits consumed in the current billing period
              </span>
            </div>
            <span className="text-sm text-muted-foreground tabular-nums shrink-0">
              0 / 1,000
            </span>
          </div>
        </div>
      </section>

      <p className="text-[13px] text-muted-foreground/60">
        Credit management coming soon.
      </p>
    </div>
  );
}
