// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
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
  IconBuilding,
  IconChartBar,
  IconCpu,
  IconUsers,
  IconCreditCard,
  IconCoins,
  IconFileInvoice,
  IconWorldWww,
} from "@tabler/icons-react";

import { OrgGeneralTab } from "./org-general-tab.tsx";
import { OrgProvidersTab } from "./org-providers-tab.tsx";
import { OrgMembersTab } from "./org-members-tab.tsx";
import { OrgDomainsTab } from "./org-domains-tab.tsx";
import { OrgBillingTab } from "./org-billing-tab.tsx";
import { OrgUsageTab } from "./org-usage-tab.tsx";
import { OrgInvoicesTab } from "./org-invoices-tab.tsx";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  orgManageTab$,
  setActiveOrgManageTab$,
  billingSubPage$,
  type OrgManageTab,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  modelUsageRankingEnabled$,
  modelUsageRankingOpen$,
  setModelUsageRankingOpen$,
} from "../../../../signals/model-usage-ranking.ts";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

interface OrgManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TAB_META = {
  general: {
    title: "General",
    description: "Manage your workspace profile and settings.",
  },
  providers: {
    title: "Model Providers",
    description:
      "Configure model providers for running tasks. You can also bring your own API key to use a custom provider.",
  },
  members: {
    title: "Members",
    description: "Manage who has access to this workspace.",
  },
  domains: {
    title: "Domains",
    description: "Manage verified domains for your workspace.",
  },
  billing: {
    title: "Billing",
    description: "Manage your plan and payment method.",
  },
  usage: {
    title: "Credit balance",
    description:
      "Credit balance and per-member credit consumption this billing period.",
  },
  invoices: {
    title: "Invoices",
    description: "View and download past invoices.",
  },
} as const;

interface SidebarGroup {
  label: string;
  items: readonly { id: OrgManageTab; label: string; icon: NavIcon }[];
}

const BILLING_GROUP = {
  label: "Billing & pricing",
  items: [
    { id: "billing", label: "Billing", icon: IconCreditCard as NavIcon },
    { id: "usage", label: "Credit balance", icon: IconCoins as NavIcon },
    { id: "invoices", label: "Invoices", icon: IconFileInvoice as NavIcon },
  ],
} as const satisfies SidebarGroup;

const CONFIGURATION_GROUP = {
  label: "Configuration",
  items: [
    {
      id: "providers",
      label: "Model Providers",
      icon: IconCpu as NavIcon,
    },
    {
      id: "domains",
      label: "Domains",
      icon: IconWorldWww as NavIcon,
    },
  ],
} as const satisfies SidebarGroup;

const BASE_SIDEBAR_GROUPS = [
  {
    label: "Workspace",
    items: [{ id: "general", label: "General", icon: IconBuilding as NavIcon }],
  },
  {
    label: "People",
    items: [{ id: "members", label: "Members", icon: IconUsers as NavIcon }],
  },
] as const satisfies readonly SidebarGroup[];

const TAB_COMPONENTS = {
  general: () => {
    return <OrgGeneralTab />;
  },
  providers: () => {
    return <OrgProvidersTab />;
  },
  members: () => {
    return <OrgMembersTab />;
  },
  domains: () => {
    return <OrgDomainsTab />;
  },
  billing: () => {
    return <OrgBillingTab />;
  },
  usage: () => {
    return <OrgUsageTab />;
  },
  invoices: () => {
    return <OrgInvoicesTab />;
  },
} as const satisfies Record<OrgManageTab, () => ReactNode>;

function TabContent({ tab }: { tab: OrgManageTab }) {
  const Content = TAB_COMPONENTS[tab];
  return <Content />;
}

export function OrgManageDialog({ open, onOpenChange }: OrgManageDialogProps) {
  const activeTab = useGet(orgManageTab$);
  const setActiveTab = useSet(setActiveOrgManageTab$);
  const rankingOpen = useGet(modelUsageRankingOpen$);
  const setRankingOpen = useSet(setModelUsageRankingOpen$);
  const rankingEnabledLoadable = useLoadable(modelUsageRankingEnabled$);
  const rankingEnabled =
    rankingEnabledLoadable.state === "hasData"
      ? rankingEnabledLoadable.data
      : false;

  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  const sidebarGroups = [
    ...BASE_SIDEBAR_GROUPS.slice(0, 1),
    ...(isAdmin ? [CONFIGURATION_GROUP] : []),
    ...BASE_SIDEBAR_GROUPS.slice(1),
    ...(isAdmin ? [BILLING_GROUP] : []),
  ];

  const meta = TAB_META[activeTab];
  const isBillingSubPage = useGet(billingSubPage$);
  const hideHeader = activeTab === "billing" && isBillingSubPage;
  const showRankingButton =
    rankingEnabled && activeTab === "providers" && !rankingOpen;
  const title =
    activeTab === "providers" && rankingOpen ? "Model Popularity" : meta.title;
  const description =
    activeTab === "providers" && rankingOpen
      ? "Ranking of the most popular models on VM0, based on platform-wide tokens."
      : meta.description;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRankingOpen(false);
    }
    return onOpenChange(nextOpen);
  };

  const handleTabChange = (tab: OrgManageTab) => {
    if (tab !== "providers") {
      setRankingOpen(false);
    }
    return setActiveTab(tab);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="zero-app flex flex-col w-[calc(100vw-2rem)] max-w-[1200px] h-[92dvh] sm:h-[85vh] p-0 gap-0 overflow-hidden zero-border rounded-xl bg-card">
        <DialogTitle className="sr-only">Workspace settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage your workspace profile, members, integrations, and billing.
        </DialogDescription>

        <div className="flex flex-col sm:flex-row h-full min-h-0">
          {/* Mobile: dropdown nav */}
          <div
            className={cn(
              "sm:hidden shrink-0 px-4 pr-14 pt-4 pb-4 border-b border-border/50 bg-[hsl(var(--gray-0))]",
              isBillingSubPage && "hidden",
            )}
          >
            <Select
              value={activeTab}
              onValueChange={(v) => {
                return handleTabChange(v as OrgManageTab);
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

          {/* Desktop: sidebar nav */}
          <nav
            className={cn(
              "hidden sm:flex sm:flex-col w-52 shrink-0 p-3 pt-3 pb-4 gap-4 overflow-y-auto zero-border-r bg-[hsl(var(--gray-0))]",
              isBillingSubPage && "sm:hidden",
            )}
          >
            {sidebarGroups.map((group) => {
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
                            return handleTabChange(item.id);
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
            id="org-manage-content"
            className="relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
            style={{ backgroundColor: "hsl(var(--background))" }}
          >
            {!hideHeader && (
              <header className="shrink-0 px-4 sm:px-10 pt-6 sm:pt-8 pb-1">
                <div className="flex min-h-7 items-center gap-2">
                  <h2 className="hidden h-7 items-center text-xl font-semibold tracking-tight text-foreground sm:flex">
                    {title}
                  </h2>
                  {showRankingButton && (
                    <button
                      type="button"
                      aria-label="Open VM0 model popularity ranking"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        return setRankingOpen(true);
                      }}
                    >
                      <IconChartBar size={15} stroke={1.75} />
                    </button>
                  )}
                </div>
                <p
                  className="mt-1 truncate whitespace-nowrap text-sm text-muted-foreground"
                  data-testid="tab-description"
                >
                  {description}
                </p>
              </header>
            )}
            <div
              className={cn(
                "flex-1 overflow-y-auto px-4 sm:px-10 pb-10 [scrollbar-gutter:stable]",
                hideHeader ? "pt-6 sm:pt-8" : "pt-4 sm:pt-6",
              )}
            >
              <TabContent tab={activeTab} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
