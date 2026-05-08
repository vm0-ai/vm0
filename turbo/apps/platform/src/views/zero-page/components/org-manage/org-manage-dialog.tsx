// TODO(#8609): split large components to comply with max-lines-per-function
// (128) and complexity (20). The mobile-native master/detail rewrite added
// branching that pushes this above the cap; the heavy lifting is delegated
// to `MobileMasterList` and `MobileDetailHeader` helpers in this file.
// oxlint-disable max-lines-per-function
// oxlint-disable complexity
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
  IconChevronLeft,
  IconChevronRight,
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
import { isMobileViewport$ } from "../../../../signals/zero-page/mobile-viewport.ts";
import {
  orgManageTab$,
  setActiveOrgManageTab$,
  billingSubPage$,
  mobileMasterMode$,
  setMobileMasterMode$,
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

// iOS Settings-style master list rendered when the dialog opens on mobile.
// Tapping a row pushes to the existing tab content as a sub-page.
function MobileMasterList({
  groups,
  onSelect,
}: {
  readonly groups: readonly SidebarGroup[];
  readonly onSelect: (id: OrgManageTab) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-5 pt-4 pb-10 [scrollbar-gutter:stable]">
      <h2 className="text-[20px] font-semibold leading-7 text-foreground pr-12">
        Workspace
      </h2>
      <p className="text-[15px] text-muted-foreground mt-1 leading-snug pr-12">
        Manage workspace profile, members, integrations, and billing.
      </p>

      <div className="flex flex-col gap-6 mt-6">
        {groups.map((group) => {
          return (
            <div key={group.label} className="flex flex-col gap-2">
              <span className="px-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </span>
              <div
                className="overflow-hidden rounded-xl bg-card"
                style={{ border: "0.7px solid hsl(var(--gray-400))" }}
              >
                {group.items.map((item, idx) => {
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelect(item.id);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors active:bg-muted/40",
                        idx > 0 &&
                          "border-t border-border/50",
                      )}
                    >
                      <span className="text-[16px] font-medium text-foreground">
                        {item.label}
                      </span>
                      <IconChevronRight
                        size={18}
                        stroke={1.5}
                        className="shrink-0 text-muted-foreground/60"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Mobile detail-page header: ← Workspace · title · (close X comes from
// the Dialog primitive). Only renders below md when the user has pushed
// into a sub-page from the master list.
function MobileDetailHeader({
  title,
  description,
  onBack,
}: {
  readonly title: string;
  readonly description: string;
  readonly onBack: () => void;
}) {
  return (
    <header className="shrink-0 px-5 pt-5 pb-1 pr-14">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 -ml-1 mb-2 text-primary text-[14px] active:opacity-60"
      >
        <IconChevronLeft size={18} stroke={2} />
        <span>Workspace</span>
      </button>
      <h2 className="text-[20px] font-semibold leading-7 text-foreground">
        {title}
      </h2>
      <p className="text-[15px] text-muted-foreground mt-1 leading-snug">
        {description}
      </p>
    </header>
  );
}

export function OrgManageDialog({ open, onOpenChange }: OrgManageDialogProps) {
  const activeTab = useGet(orgManageTab$);
  const setActiveTab = useSet(setActiveOrgManageTab$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const isMobile = useGet(isMobileViewport$);
  const masterMode = useGet(mobileMasterMode$);
  const setMasterMode = useSet(setMobileMasterMode$);

  const sidebarGroups = [
    ...BASE_SIDEBAR_GROUPS.slice(0, 1),
    ...(isAdmin ? [CONFIGURATION_GROUP] : []),
    ...BASE_SIDEBAR_GROUPS.slice(1),
    ...(isAdmin ? [BILLING_GROUP] : []),
  ];

  const meta = TAB_META[activeTab];
  const isBillingSubPage = useGet(billingSubPage$);
  const hideHeader = activeTab === "billing" && isBillingSubPage;

  const handleTabChange = (tab: OrgManageTab) => {
    return setActiveTab(tab);
  };

  // On mobile we render two surfaces inside the same dialog: a master list
  // and (after a row tap) a detail view with a back chevron. Reset to master
  // when the dialog re-opens after being closed so a previously-viewed tab
  // doesn't pre-empt the iOS-Settings-style entry point.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setMasterMode(true);
    }
    onOpenChange(next);
  };

  const showMobileMaster = isMobile && masterMode;
  const showMobileDetail = isMobile && !masterMode;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="zero-app flex flex-col w-[calc(100vw-2rem)] max-w-[1200px] h-[92dvh] sm:h-[85vh] p-0 gap-0 overflow-hidden zero-border rounded-xl bg-card">
        <DialogTitle className="sr-only">Workspace settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage your workspace profile, members, integrations, and billing.
        </DialogDescription>

        {showMobileMaster ? (
          <MobileMasterList
            groups={sidebarGroups}
            onSelect={(id) => {
              setActiveTab(id);
              setMasterMode(false);
            }}
          />
        ) : (
          <div className="flex flex-col sm:flex-row h-full min-h-0">
            {/* Desktop: sidebar nav. Hidden on mobile detail mode since the
                master list handles tab selection there. */}
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
                      <span className="text-[14px] leading-4 text-sidebar-foreground/50 font-medium">
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
              {showMobileDetail && !hideHeader && (
                <MobileDetailHeader
                  title={meta.title}
                  description={meta.description}
                  onBack={() => {
                    setMasterMode(true);
                  }}
                />
              )}
              {!showMobileDetail && !hideHeader && (
                <header className="shrink-0 px-4 sm:px-10 pt-6 sm:pt-8 pb-1">
                  <div className="flex min-h-7 items-center gap-2">
                    <h2 className="hidden h-7 items-center text-xl font-semibold tracking-tight text-foreground sm:flex">
                      {meta.title}
                    </h2>
                  </div>
                  <p
                    className="mt-1 truncate whitespace-nowrap text-sm text-muted-foreground"
                    data-testid="tab-description"
                  >
                    {meta.description}
                  </p>
                </header>
              )}
              <div
                className={cn(
                  "flex-1 overflow-y-auto pb-10 [scrollbar-gutter:stable]",
                  showMobileDetail ? "px-5 pt-4" : "px-4 sm:px-10",
                  !showMobileDetail && (hideHeader ? "pt-6 sm:pt-8" : "pt-4 sm:pt-6"),
                )}
              >
                <TabContent tab={activeTab} />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
