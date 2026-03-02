import { useGet, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { AppShell } from "../layout/app-shell.tsx";
import { NotificationSettings } from "../settings-page/notification-settings.tsx";
import { TimezoneSettings } from "../settings-page/timezone-settings.tsx";
import {
  activeTab$,
  setActiveTab$,
  type PreferencesTab,
} from "../../signals/preferences-page/preferences-tabs.ts";

export function PreferencesPage() {
  const tab = useGet(activeTab$);
  const setTab = useSet(setActiveTab$);

  return (
    <AppShell
      breadcrumb={["Preferences"]}
      title="Preferences"
      subtitle="Manage your personal preferences and notification settings"
    >
      <div className="flex flex-col gap-6 px-6 pb-8">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as PreferencesTab)}
        >
          <TabsList>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="timezone">Time Zone</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "notifications" && (
          <div className="max-w-6xl mx-auto w-full">
            <NotificationSettings />
          </div>
        )}

        {tab === "timezone" && (
          <div className="max-w-6xl mx-auto w-full">
            <TimezoneSettings />
          </div>
        )}
      </div>
    </AppShell>
  );
}
