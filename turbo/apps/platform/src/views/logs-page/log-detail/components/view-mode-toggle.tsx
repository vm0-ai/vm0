import type { ViewMode } from "../../../../signals/logs-page/log-detail-state.ts";

export function ViewModeToggle({
  mode,
  setMode,
}: {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-center">
      <button
        onClick={() => setMode("formatted")}
        className={`h-9 px-3 sm:px-4 text-sm font-medium whitespace-nowrap transition-colors rounded-l-lg ${
          mode === "formatted"
            ? "border border-sidebar-primary bg-accent text-sidebar-primary"
            : "border border-border border-r-0 bg-card text-foreground hover:bg-muted"
        }`}
      >
        Formatted
      </button>
      <button
        onClick={() => setMode("raw")}
        className={`h-9 px-3 sm:px-4 text-sm font-medium whitespace-nowrap transition-colors rounded-r-lg ${
          mode === "raw"
            ? "border border-sidebar-primary bg-accent text-sidebar-primary"
            : "border border-border border-l-0 bg-card text-foreground hover:bg-muted"
        }`}
      >
        Raw JSON
      </button>
    </div>
  );
}
