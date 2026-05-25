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
  IconAdjustmentsHorizontal,
  IconBug,
  IconBuilding,
  IconCoins,
  IconCpu,
  IconCreditCard,
  IconFileInvoice,
  IconKey,
  IconUsers,
} from "@tabler/icons-react";

import { isOrgAdmin$ } from "../../../../signals/org.ts";
import {
  isAdminOnlySettingsSection,
  settingsActiveSection$,
  externalProfileModalOpen$,
  setSettingsActiveSection$,
  type SettingsSection,
} from "../../../../signals/zero-page/settings/settings-dialog.ts";
import { PreferenceSection } from "./sections/preference-section.tsx";
import { ApiKeysSection } from "./sections/api-keys-section.tsx";
import { ModelSection } from "./sections/model-section.tsx";
import { DebugSection } from "./sections/debug-section.tsx";
import { GeneralSection } from "./sections/general-section.tsx";
import { PeopleSection } from "./sections/people-section.tsx";
import { BillingSection } from "./sections/billing-section.tsx";
import { CreditBalanceSection } from "./sections/credit-balance-section.tsx";
import { InvoicesSection } from "./sections/invoices-section.tsx";

type NavIcon = (props: { size?: number; className?: string }) => ReactNode;

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SECTION_META = {
  preference: {
    title: "Preference",
    description: "Personalize how the app looks and behaves.",
  },
  "api-keys": {
    title: "API Keys",
    description: "Create and manage API keys for programmatic access.",
  },
  model: {
    title: "Model",
    description:
      "Configure the AI providers and models available to you and your workspace.",
  },
  debug: {
    title: "Debug",
    description: "Diagnostics and developer tooling.",
  },
  general: {
    title: "General",
    description: "Manage your workspace profile and settings.",
  },
  people: {
    title: "People",
    description: "Manage who has access to this workspace.",
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
} as const satisfies Record<
  SettingsSection,
  { title: string; description: string }
>;

interface SidebarItem {
  id: SettingsSection;
  label: string;
  icon: NavIcon;
}

interface SidebarGroup {
  label: string | null;
  items: readonly SidebarItem[];
}

const PERSONAL_GROUP = {
  label: "Personal",
  items: [
    {
      id: "preference",
      label: "Preference",
      icon: IconAdjustmentsHorizontal,
    },
    { id: "api-keys", label: "API Keys", icon: IconKey },
    { id: "model", label: "Model", icon: IconCpu },
    { id: "debug", label: "Debug", icon: IconBug },
  ],
} as const satisfies SidebarGroup;

const WORKSPACE_GROUP = {
  label: "Workspace",
  items: [
    { id: "general", label: "General", icon: IconBuilding },
    { id: "people", label: "People", icon: IconUsers },
  ],
} as const satisfies SidebarGroup;

const BILLING_GROUP = {
  label: "Billing & pricing",
  items: [
    { id: "billing", label: "Billing", icon: IconCreditCard },
    { id: "usage", label: "Credit balance", icon: IconCoins },
    { id: "invoices", label: "Invoices", icon: IconFileInvoice },
  ],
} as const satisfies SidebarGroup;

const SECTION_COMPONENTS = {
  preference: () => {
    return <PreferenceSection />;
  },
  "api-keys": () => {
    return <ApiKeysSection />;
  },
  model: () => {
    return <ModelSection />;
  },
  debug: () => {
    return <DebugSection />;
  },
  general: () => {
    return <GeneralSection />;
  },
  people: () => {
    return <PeopleSection />;
  },
  billing: () => {
    return <BillingSection />;
  },
  usage: () => {
    return <CreditBalanceSection />;
  },
  invoices: () => {
    return <InvoicesSection />;
  },
} as const satisfies Record<SettingsSection, () => ReactNode>;

function SectionContent({ section }: { section: SettingsSection }) {
  const Component = SECTION_COMPONENTS[section];
  return <Component />;
}

function isClerkModalTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      [
        "[data-clerk-user-profile]",
        "[data-clerk-modal]",
        '[class*="cl-userProfile"]',
        '[class*="cl-modal"]',
      ].join(","),
    ) !== null
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const activeSection = useGet(settingsActiveSection$);
  const setActiveSection = useSet(setSettingsActiveSection$);
  const externalProfileModalOpen = useGet(externalProfileModalOpen$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  const sidebarGroups: readonly SidebarGroup[] = [
    PERSONAL_GROUP,
    ...(isAdmin ? [WORKSPACE_GROUP, BILLING_GROUP] : []),
  ];

  // If the user lost admin while the dialog is open, fall back to a safe section
  const resolvedSection: SettingsSection =
    !isAdmin && isAdminOnlySettingsSection(activeSection)
      ? "preference"
      : activeSection;
  const meta = SECTION_META[resolvedSection];

  const handleSectionChange = (section: SettingsSection) => {
    setActiveSection(section);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      modal={!externalProfileModalOpen}
    >
      <DialogContent
        className="zero-app flex flex-col w-[calc(100vw-2rem)] max-w-[1200px] h-[92dvh] sm:h-[85vh] p-0 gap-0 overflow-hidden zero-border rounded-xl bg-card"
        onInteractOutside={(event) => {
          if (isClerkModalTarget(event.target)) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Manage your account, preferences, workspace, and billing settings.
        </DialogDescription>

        <div className="flex flex-col sm:flex-row h-full min-h-0">
          {/* Mobile: dropdown nav */}
          <div className="sm:hidden shrink-0 px-4 pr-14 pt-4 pb-4 border-b border-border/50 bg-[hsl(var(--gray-0))]">
            <Select
              value={resolvedSection}
              onValueChange={(v) => {
                handleSectionChange(v as SettingsSection);
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
          <nav className="hidden sm:flex sm:flex-col w-52 shrink-0 p-3 pt-3 pb-4 gap-4 overflow-y-auto zero-border-r bg-[hsl(var(--gray-0))]">
            {sidebarGroups.map((group) => {
              const groupKey =
                group.label ?? `__personal_${group.items[0]?.id ?? ""}`;
              return (
                <div key={groupKey} className="shrink-0">
                  {group.label !== null && (
                    <div className="h-7 flex items-center pl-2">
                      <span className="text-[13px] leading-4 text-sidebar-foreground/50 font-medium">
                        {group.label}
                      </span>
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const isActive = resolvedSection === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            handleSectionChange(item.id);
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
            id="settings-dialog-content"
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
              <SectionContent section={resolvedSection} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
