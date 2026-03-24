/**
 * Skeleton placeholder that approximates the app shell layout
 * (sidebar + content area). Used in two places:
 *  1. Router — while bootstrap is in progress and page$ is still undefined
 *  2. SidebarLayout — while post-route data (agent name) loads
 */
export function AppSkeleton({ visible = true }: { visible?: boolean }) {
  return (
    <div
      className={`fixed inset-0 z-50 flex bg-background ${
        visible
          ? "opacity-100"
          : "opacity-0 pointer-events-none transition-opacity duration-300"
      }`}
    >
      {/* Sidebar skeleton */}
      <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
        {/* Org switcher */}
        <div className="shrink-0 p-2 pb-1">
          <div className="rounded-lg p-2">
            <div className="h-8 w-full rounded-lg bg-muted/50 animate-pulse" />
          </div>
        </div>
        {/* Nav + Recent */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          <div className="flex flex-col gap-1">
            {["nav-1", "nav-2", "nav-3", "nav-4", "nav-5", "nav-6"].map(
              (id, i) => (
                <div
                  key={id}
                  className="flex h-8 items-center gap-2 rounded-lg p-2"
                >
                  <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
                  <div
                    className="h-3.5 rounded bg-muted/50 animate-pulse"
                    style={{ width: `${80 + ((i * 37) % 60)}px` }}
                  />
                </div>
              ),
            )}
          </div>
          {/* Recent section */}
          <div className="mt-4">
            <div className="h-8 flex items-center px-2">
              <div className="h-3 w-20 rounded bg-muted/30 animate-pulse" />
            </div>
            <div className="flex flex-col gap-1">
              {["recent-1", "recent-2", "recent-3"].map((id, i) => (
                <div key={id} className="flex h-8 items-center rounded-lg p-2">
                  <div
                    className="h-3.5 rounded bg-muted/40 animate-pulse"
                    style={{ width: `${100 + ((i * 43) % 80)}px` }}
                  />
                </div>
              ))}
            </div>
          </div>
        </nav>
        {/* Footer */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <div className="flex h-8 items-center gap-2 rounded-lg p-2">
              <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
              <div className="h-3.5 w-28 rounded bg-muted/50 animate-pulse" />
            </div>
            {/* Account */}
            <div className="mt-2 pt-1">
              <div className="rounded-lg p-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 shrink-0 rounded-xl bg-muted/50 animate-pulse" />
                  <div className="flex-1 min-w-0">
                    <div className="h-3.5 w-24 rounded bg-muted/50 animate-pulse" />
                    <div className="h-3 w-32 rounded bg-muted/30 animate-pulse mt-1" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
      {/* Content skeleton */}
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        <div className="shrink-0 px-6 pt-6 pb-5">
          <div className="h-6 w-40 rounded bg-muted/50 animate-pulse mb-2" />
          <div className="h-4 w-64 rounded bg-muted/30 animate-pulse" />
        </div>
        <div className="flex-1 px-6">
          <div className="mx-auto max-w-[900px]">
            <div className="h-48 rounded-xl bg-muted/20 animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}
