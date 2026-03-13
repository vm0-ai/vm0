import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { NotificationSettings } from "../settings-page/notification-settings.tsx";
import { TimezoneSettings } from "../settings-page/timezone-settings.tsx";

export function ZeroPreferencesPage() {
  const tab$ = useCCState("notifications");
  const tab = useGet(tab$);
  const setTab = useSet(tab$);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px] px-7">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Preferences
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your notification and agent runtime preferences
          </p>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        <div className="mx-auto max-w-[900px] px-7 flex flex-col gap-8">
          <Tabs value={tab} onValueChange={(v) => setTab(v)}>
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="notifications"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Notifications
              </TabsTrigger>
              <TabsTrigger
                value="timezone"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                Time Zone
              </TabsTrigger>
            </TabsList>

            <div className="mt-4">
              {tab === "notifications" && <NotificationSettings />}
              {tab === "timezone" && <TimezoneSettings />}
            </div>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
