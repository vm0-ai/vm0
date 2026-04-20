import { UsageInsightView } from "../usage-page/components/usage-insight-view.tsx";

export function ZeroUsagePage() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="hidden md:block">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Usage
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Your credit and token consumption across chats, schedules, and
              channels.
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 pt-3 pb-16">
        <div className="mx-auto w-full max-w-[900px]">
          <UsageInsightView />
        </div>
      </main>
    </div>
  );
}
