import { Skeleton } from "@vm0/ui/components/ui/skeleton";

export function LogDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Info Card Skeleton */}
      <div className="p-4 pb-0 sm:px-8 sm:pt-4 sm:pb-0">
        <div className="shrink-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-0 gap-y-2 text-sm px-4 py-3 bg-card rounded-lg border border-border">
          {/* Status */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border hidden lg:block" />
          </div>

          {/* Agent */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-24" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border hidden lg:block" />
          </div>

          {/* Framework */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border hidden lg:block" />
          </div>

          {/* Duration */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-12" />
          </div>

          {/* Time */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-28" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border hidden lg:block" />
          </div>

          {/* Session ID */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-24 rounded-lg" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border hidden lg:block" />
          </div>

          {/* Run ID */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-7 w-24 rounded-lg" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-px bg-border hidden lg:block" />
          </div>

          {/* Artifacts */}
          <div className="flex items-center gap-2 px-3 relative min-w-0">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
        </div>
      </div>

      {/* Agent Events Section */}
      <div className="px-4 sm:px-8 flex flex-col gap-4 pb-8">
        {/* Header with search and controls */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="relative flex h-9 flex-1 sm:flex-none items-center rounded-lg border border-border bg-card px-3 gap-2">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
        </div>

        {/* Event items - one line per event with status dot */}
        <div>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={`event-${i}`} className="py-2 relative">
              {/* Connector line (except for last item) */}
              {i < 7 && (
                <div
                  className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/40"
                  aria-hidden="true"
                />
              )}
              <div className="flex gap-2 items-start relative">
                {/* Status dot */}
                <div className="shrink-0 relative z-10">
                  <Skeleton className="h-[7px] w-[7px] rounded-full mt-1.5" />
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <Skeleton className="h-4 w-full max-w-2xl" />
                </div>
                {/* Timestamp */}
                <Skeleton className="h-3 w-16 shrink-0 ml-4 hidden sm:block" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
