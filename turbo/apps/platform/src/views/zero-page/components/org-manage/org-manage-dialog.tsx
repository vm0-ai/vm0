import type { ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  cn,
} from "@vm0/ui";
import {
  IconBuilding,
  IconCpu,
  IconUsers,
  IconCreditCard,
  IconCoins,
  IconFileInvoice,
} from "@tabler/icons-react";

import { OrgGeneralTab } from "./org-general-tab.tsx";
import { OrgProvidersTab } from "./org-providers-tab.tsx";
import { OrgMembersTab } from "./org-members-tab.tsx";
import { OrgBillingTab } from "./org-billing-tab.tsx";
import { OrgUsageTab } from "./org-usage-tab.tsx";
import { OrgInvoicesTab } from "./org-invoices-tab.tsx";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  activeTab$,
  setActiveTab$,
  billingSubPage$,
  type OrgManageTab,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

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
      "Use your own model provider instead of credits. Add your API keys below.",
  },
  members: {
    title: "Members",
    description: "Manage who has access to this workspace.",
  },
  billing: {
    title: "Billing",
    description: "Manage your plan and payment method.",
  },
  usage: {
    title: "Usage",
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
    { id: "usage", label: "Usage", icon: IconCoins as NavIcon },
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
  general: () => <OrgGeneralTab />,
  providers: () => <OrgProvidersTab />,
  members: () => <OrgMembersTab />,
  billing: () => <OrgBillingTab />,
  usage: () => <OrgUsageTab />,
  invoices: () => <OrgInvoicesTab />,
} as const satisfies Record<OrgManageTab, () => ReactNode>;

function TabContent({ tab }: { tab: OrgManageTab }) {
  const Content = TAB_COMPONENTS[tab];
  return <Content />;
}

export function OrgManageDialog({ open, onOpenChange }: OrgManageDialogProps) {
  const activeTab = useGet(activeTab$);
  const setActiveTab = useSet(setActiveTab$);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col max-w-[960px] h-[85vh] p-0 gap-0 overflow-hidden"
        style={{
          border: "0.7px solid hsl(var(--gray-400))",
          borderRadius: "0.75rem",
          backgroundColor: "hsl(var(--card))",
        }}
      >
        <DialogTitle className="sr-only">Workspace settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage your workspace profile, members, integrations, and billing.
        </DialogDescription>

        <div className="flex h-full">
          {/* Sidebar nav — mirrors zero-sidebar.tsx styling */}
          <nav
            className="w-52 shrink-0 p-3 pt-3 pb-4 flex flex-col gap-4 overflow-y-auto"
            style={{
              borderRight: "0.7px solid hsl(var(--gray-300))",
              backgroundColor: "hsl(var(--gray-0))",
            }}
          >
            {sidebarGroups.map((group) => (
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
                        onClick={() => setActiveTab(item.id)}
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
            ))}
          </nav>

          {/* Content area */}
          <div
            className="flex-1 min-w-0 flex flex-col overflow-hidden"
            style={{ backgroundColor: "rgb(254, 254, 254)" }}
          >
            {!hideHeader && (
              <header className="shrink-0 px-10 pt-8 pb-1">
                <h2 className="text-xl font-semibold tracking-tight text-foreground">
                  {meta.title}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {meta.description}
                </p>
              </header>
            )}
            <div
              className={cn(
                "flex-1 overflow-y-auto px-10 pb-10 [scrollbar-gutter:stable]",
                hideHeader ? "pt-8" : "pt-6",
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
