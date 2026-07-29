// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
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
  IconUsers,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import {
  isAdminOnlySettingsSection,
  setSettingsClerkProfilePortalContainer$,
  settingsActiveSection$,
  setSettingsActiveSection$,
  type SettingsSection,
} from "../../../../signals/zero-page/settings/settings-dialog.ts";
import { PreferenceSection } from "./sections/preference-section.tsx";
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

interface SidebarItem {
  id: SettingsSection;
  label: string;
  icon: NavIcon;
}

interface SidebarGroup {
  label: string | null;
  items: readonly SidebarItem[];
}

const SECTION_COMPONENTS = {
  preference: () => {
    return <PreferenceSection />;
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

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation();
  const activeSection = useGet(settingsActiveSection$);
  const setActiveSection = useSet(setSettingsActiveSection$);
  const setClerkProfilePortalContainer = useSet(
    setSettingsClerkProfilePortalContainer$,
  );
  const features = useGet(featureSwitch$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const showDebug = features[FeatureSwitchKey.ZeroDebug] ?? false;
  const sectionMeta = {
    preference: {
      title: t(($) => {
        return $.settings.dialog.sections.preference.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.preference.description;
      }),
    },
    model: {
      title: t(($) => {
        return $.settings.dialog.sections.model.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.model.description;
      }),
    },
    debug: {
      title: t(($) => {
        return $.settings.dialog.sections.debug.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.debug.description;
      }),
    },
    general: {
      title: t(($) => {
        return $.settings.dialog.sections.general.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.general.description;
      }),
    },
    people: {
      title: t(($) => {
        return $.settings.dialog.sections.people.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.people.description;
      }),
    },
    billing: {
      title: t(($) => {
        return $.settings.dialog.sections.billing.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.billing.description;
      }),
    },
    usage: {
      title: t(($) => {
        return $.settings.dialog.sections.usage.balanceTitle;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.usage.balanceDescription;
      }),
    },
    invoices: {
      title: t(($) => {
        return $.settings.dialog.sections.invoices.title;
      }),
      description: t(($) => {
        return $.settings.dialog.sections.invoices.description;
      }),
    },
  } satisfies Record<SettingsSection, { title: string; description: string }>;
  const personalItems: readonly SidebarItem[] = [
    {
      id: "preference",
      label: sectionMeta.preference.title,
      icon: IconAdjustmentsHorizontal,
    },
    { id: "debug", label: sectionMeta.debug.title, icon: IconBug },
  ];
  const personalGroup: SidebarGroup = {
    label: t(($) => {
      return $.settings.dialog.groups.personal;
    }),
    items: personalItems.filter((item) => {
      return item.id !== "debug" || showDebug;
    }),
  };
  const workspaceGroup: SidebarGroup = {
    label: t(($) => {
      return $.settings.dialog.groups.workspace;
    }),
    items: [
      {
        id: "general",
        label: sectionMeta.general.title,
        icon: IconBuilding,
      },
      { id: "people", label: sectionMeta.people.title, icon: IconUsers },
    ],
  };
  const modelsGroup: SidebarGroup = {
    label: t(($) => {
      return $.settings.dialog.groups.models;
    }),
    items: [{ id: "model", label: sectionMeta.model.title, icon: IconCpu }],
  };
  const billingGroup: SidebarGroup = {
    label: t(($) => {
      return $.settings.dialog.groups.billing;
    }),
    items: [
      {
        id: "usage",
        label: isAdmin
          ? sectionMeta.usage.title
          : t(($) => {
              return $.settings.dialog.sections.usage.usageTitle;
            }),
        icon: IconCoins,
      },
      ...(isAdmin
        ? [
            {
              id: "billing" as const,
              label: sectionMeta.billing.title,
              icon: IconCreditCard,
            },
            {
              id: "invoices" as const,
              label: sectionMeta.invoices.title,
              icon: IconFileInvoice,
            },
          ]
        : []),
    ],
  };
  const sidebarGroups: readonly SidebarGroup[] = [
    personalGroup,
    ...(isAdmin ? [workspaceGroup] : []),
    modelsGroup,
    billingGroup,
  ];

  // If the user lost admin while the dialog is open, fall back to a safe section
  const resolvedSection: SettingsSection =
    (!showDebug && activeSection === "debug") ||
    (!isAdmin && isAdminOnlySettingsSection(activeSection))
      ? "preference"
      : activeSection;
  const meta =
    resolvedSection === "usage" && !isAdmin
      ? {
          title: t(($) => {
            return $.settings.dialog.sections.usage.usageTitle;
          }),
          description: t(($) => {
            return $.settings.dialog.sections.usage.usageDescription;
          }),
        }
      : sectionMeta[resolvedSection];

  const handleSectionChange = (section: SettingsSection) => {
    setActiveSection(section);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={setClerkProfilePortalContainer}
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
        className="zero-app flex flex-col w-[calc(100vw-2rem)] max-w-[1200px] h-[92dvh] sm:h-[85vh] p-0 gap-0 overflow-hidden zero-border rounded-xl bg-card"
      >
        <DialogTitle className="sr-only">
          {t(($) => {
            return $.settings.dialog.title;
          })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t(($) => {
            return $.settings.dialog.description;
          })}
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
                            "flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 focus-visible:bg-sidebar-accent focus-visible:outline-none",
                            isActive
                              ? "bg-gray-200 text-gray-900 font-medium"
                              : "text-sidebar-foreground hover:bg-sidebar-accent",
                          )}
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
