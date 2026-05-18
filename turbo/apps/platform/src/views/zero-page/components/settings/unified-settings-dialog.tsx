// TODO(handoff): wire signal-based open state and active-tab state, replace local React state.
// TODO(handoff): once this dialog ships, deprecate the standalone /settings, /usage, /_/lab
// routes and the Preferences / Usage / Lab items from zero-sidebar-account.tsx.
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useLoadable, useLastResolved, useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import {
  IconPalette,
  IconClock,
  IconCpu,
  IconChartBar,
  IconFlask,
  IconBug,
  IconBuilding,
  IconUsers,
  IconWorldWww,
  IconCreditCard,
  IconCoins,
  IconFileInvoice,
} from "@tabler/icons-react";

import { OrgGeneralTab } from "../org-manage/org-general-tab.tsx";
import { OrgProvidersTab } from "../org-manage/org-providers-tab.tsx";
import { OrgMembersTab } from "../org-manage/org-members-tab.tsx";
import { OrgDomainsTab } from "../org-manage/org-domains-tab.tsx";
import { OrgBillingTab } from "../org-manage/org-billing-tab.tsx";
import { OrgUsageTab } from "../org-manage/org-usage-tab.tsx";
import { OrgInvoicesTab } from "../org-manage/org-invoices-tab.tsx";
import { PersonalProvidersTab } from "../preferences/personal-providers-tab.tsx";
import { TimezoneSettings } from "./timezone-settings.tsx";
import {
  AppearanceSettings,
  SendModeSettings,
  CaptureNetworkBodiesSettings,
} from "../../zero-account-page.tsx";
import { LabBody } from "../../../lab-page/lab-page.tsx";
import { UsageBody } from "../../zero-usage-page.tsx";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  activeUnifiedSettingsTab$,
  setActiveUnifiedSettingsTab$,
  type UnifiedSettingsTabId,
} from "../../../../signals/zero-page/settings/unified-settings-tab.ts";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

type SettingsTabId = UnifiedSettingsTabId;

interface TabMeta {
  title: string;
  description: string;
}

const TAB_META = {
  appearance: {
    title: "Appearance",
    description: "Theme and chat input shortcuts.",
  },
  timezone: {
    title: "Time zone",
    description:
      "How Zero interprets times in your conversations and schedules.",
  },
  "personal-models": {
    title: "Personal models",
    description:
      "Connect your own Claude Code or ChatGPT credentials. These power coding agents you spawn from your account.",
  },
  usage: {
    title: "Usage",
    description:
      "Your credit consumption across chats, schedules, and channels.",
  },
  lab: {
    title: "Lab",
    description: "Toggle experimental features on or off.",
  },
  debug: {
    title: "Debug",
    description: "Diagnostics for engineering. Off by default.",
  },
  general: {
    title: "General",
    description: "Manage your workspace profile and settings.",
  },
  members: {
    title: "Members",
    description: "Manage who has access to this workspace.",
  },
  "ws-models": {
    title: "Models configuration",
    description:
      "Manage workspace models, set the default model, and choose how each model is routed.",
  },
  domains: {
    title: "Domains",
    description: "Manage verified domains for your workspace.",
  },
  billing: {
    title: "Billing",
    description: "Manage your plan and payment method.",
  },
  "credit-balance": {
    title: "Credit balance",
    description:
      "Credit balance and per-member credit consumption this billing period.",
  },
  invoices: {
    title: "Invoices",
    description: "View and download past invoices.",
  },
} as const satisfies Record<SettingsTabId, TabMeta>;

interface SidebarItem {
  id: SettingsTabId;
  label: string;
  icon: NavIcon;
}

interface SidebarGroup {
  label: string;
  items: readonly SidebarItem[];
}

const PERSONAL_GROUP_BASE: readonly SidebarItem[] = [
  { id: "appearance", label: "Appearance", icon: IconPalette as NavIcon },
  { id: "timezone", label: "Time zone", icon: IconClock as NavIcon },
  { id: "personal-models", label: "Personal models", icon: IconCpu as NavIcon },
  { id: "usage", label: "Usage", icon: IconChartBar as NavIcon },
  { id: "lab", label: "Lab", icon: IconFlask as NavIcon },
];

const WORKSPACE_GROUP_BASE: readonly SidebarItem[] = [
  { id: "general", label: "General", icon: IconBuilding as NavIcon },
  { id: "members", label: "Members", icon: IconUsers as NavIcon },
];

const WORKSPACE_ADMIN_CONFIG: readonly SidebarItem[] = [
  { id: "ws-models", label: "Models configuration", icon: IconCpu as NavIcon },
  { id: "domains", label: "Domains", icon: IconWorldWww as NavIcon },
];

const WORKSPACE_BILLING: readonly SidebarItem[] = [
  { id: "billing", label: "Billing", icon: IconCreditCard as NavIcon },
  { id: "credit-balance", label: "Credit balance", icon: IconCoins as NavIcon },
  { id: "invoices", label: "Invoices", icon: IconFileInvoice as NavIcon },
];

function TabBody({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case "appearance": {
      return (
        <div className="flex flex-col gap-6">
          <AppearanceSettings />
          <SendModeSettings />
        </div>
      );
    }
    case "timezone": {
      return <TimezoneSettings />;
    }
    case "personal-models": {
      return <PersonalProvidersTab />;
    }
    case "usage": {
      return <UsageBody />;
    }
    case "lab": {
      return <LabBody showResetButton />;
    }
    case "debug": {
      return (
        <div className="flex flex-col gap-6">
          <CaptureNetworkBodiesSettings />
        </div>
      );
    }
    case "general": {
      return <OrgGeneralTab />;
    }
    case "members": {
      return <OrgMembersTab />;
    }
    case "ws-models": {
      return <OrgProvidersTab />;
    }
    case "domains": {
      return <OrgDomainsTab />;
    }
    case "billing": {
      return <OrgBillingTab />;
    }
    case "credit-balance": {
      return <OrgUsageTab />;
    }
    case "invoices": {
      return <OrgInvoicesTab />;
    }
  }
}

interface UnifiedSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UnifiedSettingsDialog({
  open,
  onOpenChange,
}: UnifiedSettingsDialogProps) {
  const activeTab = useGet(activeUnifiedSettingsTab$);
  const setActiveTab = useSet(setActiveUnifiedSettingsTab$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const features = useLastResolved(featureSwitch$);
  const showDebug = features?.[FeatureSwitchKey.ZeroDebug] ?? false;

  const personalItems: SidebarItem[] = [
    ...PERSONAL_GROUP_BASE,
    ...(showDebug
      ? [{ id: "debug" as const, label: "Debug", icon: IconBug as NavIcon }]
      : []),
  ];

  const workspaceItems: SidebarItem[] = [
    ...WORKSPACE_GROUP_BASE,
    ...(isAdmin ? WORKSPACE_ADMIN_CONFIG : []),
    ...(isAdmin ? WORKSPACE_BILLING : []),
  ];

  const sidebarGroups: SidebarGroup[] = [
    { label: "Personal", items: personalItems },
    { label: "Workspace", items: workspaceItems },
  ];

  const meta = TAB_META[activeTab];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="zero-app flex flex-col w-[calc(100vw-2rem)] max-w-[1200px] h-[92dvh] sm:h-[85vh] p-0 gap-0 overflow-hidden zero-border rounded-xl bg-card">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Personal preferences and workspace configuration.
        </DialogDescription>

        <div className="flex flex-col sm:flex-row h-full min-h-0">
          {/* Mobile: dropdown nav */}
          <div className="sm:hidden shrink-0 px-4 pr-14 pt-4 pb-4 border-b border-border/50 bg-[hsl(var(--gray-0))]">
            <Select
              value={activeTab}
              onValueChange={(v) => {
                return setActiveTab(v as SettingsTabId);
              }}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sidebarGroups.flatMap((group) => {
                  return group.items.map((item) => {
                    return (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    );
                  });
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Desktop: sidebar nav with Personal / Workspace groups */}
          <nav className="hidden sm:flex sm:flex-col w-56 shrink-0 p-3 pt-3 pb-4 gap-4 overflow-y-auto zero-border-r bg-[hsl(var(--gray-0))]">
            {sidebarGroups.map((group) => {
              if (group.items.length === 0) {
                return null;
              }
              return (
                <div key={group.label} className="shrink-0">
                  <div className="h-7 flex items-center pl-2">
                    <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium">
                      {group.label}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeTab === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            return setActiveTab(item.id);
                          }}
                          className={cn(
                            "flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200",
                            isActive
                              ? "text-primary-foreground font-medium"
                              : "text-sidebar-foreground hover:bg-sidebar-accent",
                          )}
                          style={
                            isActive
                              ? { backgroundColor: "hsl(var(--primary))" }
                              : undefined
                          }
                        >
                          <Icon
                            size={16}
                            className={cn(
                              "shrink-0",
                              isActive ? "opacity-100" : "opacity-50",
                            )}
                          />
                          <span className="truncate">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          {/* Content area */}
          <div
            id="unified-settings-content"
            className="relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
            style={{ backgroundColor: "hsl(var(--background))" }}
          >
            <header className="shrink-0 px-4 sm:px-10 pt-6 sm:pt-8 pb-1">
              <div className="flex min-h-7 items-center gap-2">
                <h2 className="hidden h-7 items-center text-xl font-semibold tracking-tight text-foreground sm:flex">
                  {meta.title}
                </h2>
              </div>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {meta.description}
              </p>
            </header>
            <div className="flex-1 overflow-y-auto px-4 sm:px-10 pb-10 pt-4 sm:pt-6 [scrollbar-gutter:stable]">
              <TabBody tab={activeTab} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type { SettingsTabId };
