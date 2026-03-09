import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { Card, CardContent } from "@vm0/ui/components/ui/card";
import type { ZeroAccountSubId } from "./zero-sidebar.tsx";

interface ZeroAccountPageProps {
  accountSubId: ZeroAccountSubId;
}

export function ZeroAccountPage({ accountSubId }: ZeroAccountPageProps) {
  if (accountSubId === "preferences") {
    return <ZeroPreferencesSubPage />;
  }
  return <ZeroAccountOverview />;
}

function ZeroAccountOverview() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 border-b border-divider bg-transparent px-4 sm:px-6 pt-6 sm:pt-6 pb-4 sm:pb-5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Account
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Use the account menu in the sidebar to open Preferences or Manage
          account.
        </p>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pb-8">
        <div className="mx-auto max-w-[900px]">
          <div className="zero-card p-6">
            <p className="text-sm text-muted-foreground">
              Your profile and settings are available from the account dropdown
              at the bottom of the sidebar.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function ZeroPreferencesSubPage() {
  const [tab, setTab] = useState("notifications");

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 border-b border-divider bg-transparent px-4 sm:px-6 pt-6 sm:pt-6 pb-4 sm:pb-5">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Preferences
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Manage your notification and agent runtime preferences
        </p>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="timezone">Time Zone</TabsTrigger>
            </TabsList>

            {tab === "notifications" && (
              <Card className="zero-card">
                <CardContent className="p-6">
                  <h2 className="text-sm font-medium text-foreground mb-1">
                    Notifications
                  </h2>
                  <p className="text-sm text-muted-foreground mb-4">
                    Choose how you get notified when scheduled agent runs
                    complete or fail.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Notification preferences will appear here.
                  </p>
                </CardContent>
              </Card>
            )}

            {tab === "timezone" && (
              <Card className="zero-card">
                <CardContent className="p-6">
                  <h2 className="text-sm font-medium text-foreground mb-1">
                    Time Zone
                  </h2>
                  <p className="text-sm text-muted-foreground mb-4">
                    Set your time zone for schedules and activity logs.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Time zone settings will appear here.
                  </p>
                </CardContent>
              </Card>
            )}
          </Tabs>
        </div>
      </main>
    </div>
  );
}
