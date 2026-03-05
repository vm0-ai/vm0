import { useState } from "react";
import {
  IconSettings,
  IconUsers,
  IconCreditCard,
  IconBell,
  IconPlus,
  IconMail,
} from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger, Button, cn } from "@vm0/ui";

type SettingsTab = "general" | "credits" | "team" | "notifications";

const MOCK_MEMBERS: {
  id: string;
  name: string;
  email: string;
  role: "Admin" | "Member";
  joinedDate: string;
}[] = [
  {
    id: "1",
    name: "John Doe",
    email: "john@example.com",
    role: "Admin",
    joinedDate: "1/1/2024",
  },
  {
    id: "2",
    name: "Jane Smith",
    email: "jane@example.com",
    role: "Member",
    joinedDate: "2/15/2024",
  },
];

const MOCK_USAGE_HISTORY: {
  id: string;
  entity: string;
  date: string;
  consumption: number;
  balance: number;
}[] = [
  {
    id: "1",
    entity: "Zero Agent",
    date: "2026-02-19",
    consumption: -45,
    balance: 2450,
  },
  {
    id: "2",
    entity: "Workflow: Daily Digest",
    date: "2026-02-18",
    consumption: -30,
    balance: 2495,
  },
  {
    id: "3",
    entity: "Zero Agent",
    date: "2026-02-17",
    consumption: -60,
    balance: 2525,
  },
];

export function ZeroTeamPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("credits");

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Workspace Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage settings for your current workspace
          </p>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as SettingsTab)}
            className="mt-4 w-full"
          >
            <TabsList className="h-9 w-full sm:w-auto gap-1 bg-muted/60 px-1 py-1">
              <TabsTrigger
                value="general"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconSettings size={14} stroke={1.5} />
                General
              </TabsTrigger>
              <TabsTrigger
                value="credits"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconCreditCard size={14} stroke={1.5} />
                Credits
              </TabsTrigger>
              <TabsTrigger
                value="team"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconUsers size={14} stroke={1.5} />
                Team
              </TabsTrigger>
              <TabsTrigger
                value="notifications"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconBell size={14} stroke={1.5} />
                Notifications
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {activeTab === "credits" && (
            <>
              {/* Credits Balance — from image */}
              <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div>
                    <h2 className="text-base font-semibold tracking-tight text-foreground">
                      Credits Balance
                    </h2>
                    <p className="mt-2 text-2xl font-semibold text-foreground">
                      2,450
                    </p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Available Credits
                    </p>
                  </div>
                  <Button size="sm" className="h-9 gap-1.5 shrink-0">
                    <IconPlus size={16} stroke={1.5} />
                    Purchase Credits
                  </Button>
                </div>
                <div className="mt-5 pt-5 border-t border-divider grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">This Month</p>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      1,250
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Current Plan
                    </p>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      Free Tier
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Renewal Date
                    </p>
                    <p className="text-sm font-medium text-foreground mt-0.5">
                      -
                    </p>
                  </div>
                </div>
              </div>

              {/* Usage History — from image */}
              <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                <h2 className="text-base font-semibold tracking-tight text-foreground">
                  Usage History
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Recent credits consumption records.
                </p>
                <div className="mt-4 flex flex-col gap-4">
                  {MOCK_USAGE_HISTORY.map((row) => (
                    <div
                      key={row.id}
                      className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {row.entity}
                        </p>
                        <p className="text-sm text-muted-foreground truncate">
                          {row.date}
                        </p>
                      </div>
                      <div className="flex flex-col items-end shrink-0 sm:mt-0 mt-1">
                        <p className="text-sm font-medium text-foreground">
                          {row.consumption}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Balance: {row.balance}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeTab === "team" && (
            <div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-foreground">
                    Team Members
                  </h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Manage team members and invitations
                  </p>
                </div>
                <Button size="sm" className="h-9 gap-1.5 shrink-0">
                  <IconMail size={16} stroke={1.5} />
                  Invite Member
                </Button>
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-3 text-left font-medium text-foreground">
                        Member
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-foreground">
                        Role
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-foreground">
                        Email
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-foreground">
                        Joined
                      </th>
                      <th
                        className="w-[4.5rem] px-4 py-3"
                        aria-label="Actions"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {MOCK_MEMBERS.map((member) => (
                      <tr
                        key={member.id}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-primary-foreground text-xs font-medium">
                              {member.name.charAt(0)}
                            </span>
                            <span className="font-medium text-foreground">
                              {member.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-md bg-zinc-100 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider dark:bg-zinc-800/80",
                              member.role === "Admin"
                                ? "text-zinc-800 dark:text-zinc-200"
                                : "text-zinc-600 dark:text-zinc-400",
                            )}
                          >
                            {member.role}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {member.email}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {member.joinedDate}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {member.role === "Member" ? (
                            <button
                              type="button"
                              className="text-destructive hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(activeTab === "general" || activeTab === "notifications") && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <p className="text-sm text-muted-foreground">
                Content for {activeTab} will appear here.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
