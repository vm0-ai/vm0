// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  type Loadable,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Search, Plus, Filter, ChevronDown, Check } from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  PublicConnectorCatalogCategoryMetadata,
  PublicConnectorCatalogDiscoveryResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { Tabs, TabsList, TabsTrigger } from "@okouai/ui/components/ui/tabs";
import {
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui/components/ui/segment-control";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import {
  connectorsPageTab$,
  setConnectorsPageTab$,
  openCustomConnectorCreateDialog$,
} from "../../signals/okou-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { agents$ } from "../../signals/agent.ts";
import { CustomConnectorsPanel } from "./components/settings/custom-connectors-panel.tsx";
import {
  connectorCatalogDiscovery$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowConnectorSlug$,
  runConnectorConnectSuccess$,
  connectorsSearch$,
  connectorsCategoryFilter$,
  connectorsConnectionFilter$,
  filteredConnectorCatalogItems$,
  setConnectorsCategoryFilter$,
  setConnectorsConnectionFilter$,
  setConnectorsSearch$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  relatedCatalogItems$,
  scopeReviewSelection$,
  setScopeReviewSelection$,
  type ConnectorsConnectionFilter,
} from "../../signals/okou-page/settings/connectors.ts";
import {
  buildConnectorShelves,
  type ConnectorShelfLayout,
} from "../../signals/okou-page/settings/connector-shelves.ts";
import {
  activeConnectorCategoryId$,
  attachConnectorCategoryScrollTracking$,
  getConnectorCategorySectionId,
  groupConnectorsByCategory,
  resetActiveConnectorCategory$,
  scrollToConnectorCategory,
  type ConnectorCategoryGroup,
  type ConnectorCategorySection,
} from "../../signals/okou-page/settings/connector-categories.ts";
import { localizeConnectorCategoryMetadata } from "./components/settings/connector-category-labels.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  ConnectorCard,
  connectorAccountSummaryStatus,
  DIRECTORY_HAIRLINE,
  type ConnectorAccountSummaryStatus,
} from "./components/settings/connector-card.tsx";
import {
  ConnectorShelfChips,
  ConnectorShelfSection,
} from "./components/settings/connector-shelf.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./components/settings/launch-connector-connect.ts";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { ConnectorAccessManagementDialog } from "./components/settings/connector-access-management-dialog.tsx";
import {
  ConnectorAgentAccessButton,
  connectorAgentAccessStatus,
} from "./components/settings/connector-agent-access-button.tsx";
import {
  closeConnectorAccessManagement$,
  connectorAuthorizedAgentsBySlug$,
  managedConnectorAccessSlug$,
  setManagedConnectorAccessSlug$,
} from "../../signals/okou-page/settings/connector-access-management.ts";
import { noConnectorImg } from "./platform-assets.ts";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import {
  cn,
  surfaceVariants,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Input,
} from "@okouai/ui";
import { i18n } from "../../i18n/index.ts";
import { connectorAccountSummaryByTarget$ } from "../../signals/okou-page/connector-accounts.ts";
import { ConnectorAccountManagerDialog } from "./components/settings/connector-account-manager-dialog.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  builtinAccountConnectDialog$,
  builtinAccountManager$,
  closeBuiltinAccountConnectDialog$,
  closeBuiltinAccountManager$,
  finishConnectorAccountConnection$,
  openBuiltinAccountConnectDialog$,
  openBuiltinAccountManager$,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { ConnectorAccountNameDialog } from "./components/settings/connector-account-name-dialog.tsx";

// Callback ref that attaches scroll tracking while enabled. Each call returns
// a fresh ref callback; React only invokes it when the underlying element
// changes, so listeners are registered on mount and cleaned up on unmount.
function useScrollTrackingRef(
  enabled: boolean,
  attach: (el: HTMLElement) => () => void,
  resetActive: () => void,
) {
  let cleanup: (() => void) | null = null;
  return (el: HTMLDivElement | null) => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    if (el && enabled) {
      cleanup = attach(el);
    } else {
      resetActive();
    }
  };
}

function ConnectorCategoryMenu({
  activeCategoryId,
  groups,
}: {
  activeCategoryId: string | null;
  groups: readonly ConnectorCategoryGroup<PlatformConnectorCatalogStatusItem>[];
}) {
  const { t } = useTranslation();
  if (groups.length <= 1) {
    return null;
  }

  return (
    <aside className="pointer-events-none fixed right-6 top-[28vh] z-30 hidden w-44 min-[1332px]:block">
      <nav
        aria-label={t(($) => {
          return $.connectors.catalog.categoriesAria;
        })}
        className="group pointer-events-auto ml-auto flex max-h-[68vh] w-6 flex-col gap-3 overflow-x-hidden overflow-y-auto rounded-xl border border-transparent bg-transparent px-1 py-2 transition-all duration-150 hover:w-44 hover:border-border/60 hover:bg-popover hover:shadow-lg focus-within:w-44 focus-within:border-border/60 focus-within:bg-popover focus-within:shadow-lg 2xl:ml-0 2xl:w-full 2xl:overflow-y-auto 2xl:rounded-none 2xl:border-transparent 2xl:px-0 2xl:py-0 2xl:pb-3 2xl:pl-5 2xl:hover:w-full 2xl:hover:border-transparent 2xl:hover:bg-transparent 2xl:hover:shadow-none 2xl:focus-within:w-full 2xl:focus-within:border-transparent 2xl:focus-within:bg-transparent 2xl:focus-within:shadow-none"
      >
        {groups.flatMap((group) => {
          if (group.kind === "group") {
            const isActiveChild = group.sections.some((section) => {
              return activeCategoryId === section.category;
            });
            return [
              <ConnectorCategoryMenuItem
                key={group.id}
                activeState={
                  activeCategoryId === group.id
                    ? "current"
                    : isActiveChild
                      ? "ancestor"
                      : null
                }
                depth="parent"
                label={group.label}
                menuLabel={group.menuLabel}
                targetId={group.id}
                onClick={() => {
                  scrollToConnectorCategory(group.id);
                }}
              />,
              ...group.sections.map((section) => {
                return (
                  <ConnectorCategoryMenuItem
                    key={section.category}
                    activeState={
                      activeCategoryId === section.category ? "current" : null
                    }
                    depth="child"
                    label={section.label}
                    menuLabel={section.menuLabel}
                    targetId={section.category}
                    onClick={() => {
                      scrollToConnectorCategory(section.category);
                    }}
                  />
                );
              }),
            ];
          }

          const section = group.sections[0];
          return [
            <ConnectorCategoryMenuItem
              key={section.category}
              activeState={
                activeCategoryId === section.category ? "current" : null
              }
              depth="parent"
              label={section.label}
              menuLabel={section.menuLabel}
              targetId={section.category}
              onClick={() => {
                scrollToConnectorCategory(section.category);
              }}
            />,
          ];
        })}
      </nav>
    </aside>
  );
}

function ConnectorCategoryMenuItem({
  activeState,
  depth,
  label,
  menuLabel,
  targetId,
  onClick,
}: {
  activeState: "current" | "ancestor" | null;
  depth: "parent" | "child";
  label: string;
  menuLabel: string;
  targetId: string;
  onClick: () => void;
}) {
  const isChild = depth === "child";
  const lineClass =
    activeState === "current"
      ? isChild
        ? "ml-1 w-3 bg-foreground/70 group-hover/item:bg-foreground/80"
        : "w-4 bg-foreground/70 group-hover/item:bg-foreground/80"
      : activeState === "ancestor"
        ? "w-4 bg-muted-foreground/55 group-hover/item:bg-foreground/60"
        : isChild
          ? "ml-1 w-3 bg-muted-foreground/20 group-hover:bg-muted-foreground/35 group-hover/item:bg-foreground/50"
          : "w-4 bg-muted-foreground/20 group-hover:bg-muted-foreground/35 group-hover/item:bg-foreground/50";

  return (
    <button
      type="button"
      aria-label={label}
      aria-current={activeState === "current" ? "true" : undefined}
      data-testid={`connector-category-menu-${targetId}`}
      title={label}
      className={`group/item relative flex h-3 w-full items-center text-left leading-snug transition-all duration-150 group-hover:h-5 group-focus-within:h-5 2xl:group-hover:h-3 2xl:group-focus-within:h-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 ${
        activeState === "current"
          ? isChild
            ? "text-[11px] text-foreground hover:text-foreground"
            : "text-xs font-medium text-foreground hover:text-foreground"
          : isChild
            ? "text-[11px] text-muted-foreground/70 hover:text-foreground"
            : "text-xs font-medium text-muted-foreground hover:text-foreground"
      }`}
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className={`block h-0.5 rounded-sm transition-all duration-150 group-hover:opacity-0 group-focus-within:opacity-0 2xl:group-hover:opacity-100 2xl:group-focus-within:opacity-100 ${lineClass}`}
      />
      <span className="absolute left-0 top-1/2 block -translate-y-1/2 translate-x-1 whitespace-nowrap opacity-0 transition-all duration-150 group-hover:left-3 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:left-3 group-focus-within:translate-x-0 group-focus-within:opacity-100 2xl:left-7 2xl:group-hover:left-7 2xl:group-focus-within:left-7">
        {menuLabel}
      </span>
    </button>
  );
}

function ConnectorFilterSectionLabel({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground/80">
      {children}
    </div>
  );
}

function ConnectorFilterOption({
  active,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenuItem className="justify-between gap-2" onClick={onSelect}>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
      {active && <Check size={15} className="shrink-0 text-foreground" />}
    </DropdownMenuItem>
  );
}

function ConnectorFilterDropdown({
  value,
  agents,
  onChange,
}: {
  readonly value: ConnectorsConnectionFilter;
  readonly agents: readonly AgentResponse[];
  readonly onChange: (value: ConnectorsConnectionFilter) => void;
}) {
  const { t } = useTranslation();
  const activeAgent =
    value.kind === "agent"
      ? agents.find((agent) => {
          return agent.agentId === value.agentId;
        })
      : undefined;
  const triggerLabel =
    value.kind === "connected"
      ? t(($) => {
          return $.connectors.catalog.filters.connected;
        })
      : value.kind === "not-connected"
        ? t(($) => {
            return $.connectors.catalog.filters.notConnected;
          })
        : value.kind === "agent" && activeAgent
          ? connectorAgentName(activeAgent)
          : t(($) => {
              return $.connectors.catalog.filters.all;
            });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t(($) => {
            return $.connectors.catalog.filters.aria;
          })}
          className="okou-btn-morandi hidden h-9 shrink-0 gap-1.5 rounded-lg border sm:inline-flex"
        >
          <Filter size={14} className="" />
          {activeAgent && (
            <AvatarFromUrl
              avatarUrl={activeAgent.avatarUrl}
              alt={connectorAgentName(activeAgent)}
              size={16}
              className="h-4 w-4 rounded-full object-cover"
            />
          )}
          <span className="max-w-[140px] truncate">{triggerLabel}</span>
          <ChevronDown size={14} className="" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(420px,var(--available-height))] w-56 overflow-y-auto"
      >
        <ConnectorFilterOption
          active={value.kind === "all"}
          onSelect={() => {
            onChange({ kind: "all" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.filters.all;
          })}
        </ConnectorFilterOption>
        <DropdownMenuSeparator />
        <ConnectorFilterSectionLabel>
          {t(($) => {
            return $.connectors.catalog.filters.status;
          })}
        </ConnectorFilterSectionLabel>
        <ConnectorFilterOption
          active={value.kind === "connected"}
          onSelect={() => {
            onChange({ kind: "connected" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.filters.connected;
          })}
        </ConnectorFilterOption>
        <ConnectorFilterOption
          active={value.kind === "not-connected"}
          onSelect={() => {
            onChange({ kind: "not-connected" });
          }}
        >
          {t(($) => {
            return $.connectors.catalog.filters.notConnected;
          })}
        </ConnectorFilterOption>
        {agents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <ConnectorFilterSectionLabel>
              {t(($) => {
                return $.connectors.catalog.filters.agents;
              })}
            </ConnectorFilterSectionLabel>
            {agents.map((agent) => {
              return (
                <ConnectorFilterOption
                  key={agent.agentId}
                  active={
                    value.kind === "agent" && value.agentId === agent.agentId
                  }
                  onSelect={() => {
                    onChange({ kind: "agent", agentId: agent.agentId });
                  }}
                >
                  <AvatarFromUrl
                    avatarUrl={agent.avatarUrl}
                    alt={connectorAgentName(agent)}
                    size={16}
                    className="h-4 w-4 rounded-full object-cover"
                  />
                  <span className="truncate">{connectorAgentName(agent)}</span>
                </ConnectorFilterOption>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Status as its own control. The dropdown it replaces mixed three unrelated
 * dimensions — everything, connection status, and one entry per agent — into a
 * single mutually exclusive list that grew without bound as the account aged,
 * while category, the only dimension that organises four thousand connectors,
 * was not offered at all. Which agents may use a connector is answered on the
 * connector's own card, where the question is actually asked.
 */
function ConnectorStatusSegment({
  value,
  onChange,
}: {
  readonly value: ConnectorsConnectionFilter;
  readonly onChange: (value: ConnectorsConnectionFilter) => void;
}) {
  const { t } = useTranslation();
  const selected =
    value.kind === "connected" || value.kind === "not-connected"
      ? value.kind
      : "all";
  return (
    <SegmentControl
      size="sm"
      value={selected}
      onValueChange={(next: string) => {
        onChange(
          next === "connected"
            ? { kind: "connected" }
            : next === "not-connected"
              ? { kind: "not-connected" }
              : { kind: "all" },
        );
      }}
      aria-label={t(($) => {
        return $.connectors.catalog.filters.status;
      })}
    >
      <SegmentControlItem value="all">
        {t(($) => {
          return $.connectors.catalog.filters.all;
        })}
      </SegmentControlItem>
      <SegmentControlItem value="connected">
        {t(($) => {
          return $.connectors.catalog.filters.connected;
        })}
      </SegmentControlItem>
      <SegmentControlItem value="not-connected">
        {t(($) => {
          return $.connectors.catalog.filters.notConnected;
        })}
      </SegmentControlItem>
    </SegmentControl>
  );
}

/** Category chips: the browse dimension the filter dropdown never offered. */
function ConnectorCategoryChipRow({
  sections,
  categoryCounts,
  selected,
  onSelect,
}: {
  readonly sections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly selected: string | null;
  readonly onSelect: (category: string | null) => void;
}) {
  const { t } = useTranslation();
  // Weight stays on the base class: the row is horizontal and every chip is
  // auto-width, so a heavier selected label would shift every chip after it.
  const chipClass = (active: boolean) => {
    return cn(
      "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg bg-gray-50 px-2.5 text-xs font-medium transition-colors",
      DIRECTORY_HAIRLINE,
      active
        ? "bg-state-selected text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );
  };
  return (
    <div className="overflow-x-auto [scrollbar-width:none]">
      <div className="flex w-max gap-1.5 pb-1">
        <button
          type="button"
          data-connector-category-chip=""
          className={chipClass(selected === null)}
          onClick={() => {
            onSelect(null);
          }}
        >
          {t(($) => {
            return $.connectors.catalog.shelf.browseAll;
          })}
        </button>
        {sections.map((section) => {
          return (
            <button
              key={section.category}
              type="button"
              data-connector-category-chip=""
              className={chipClass(selected === section.category)}
              onClick={() => {
                onSelect(section.category);
              }}
            >
              {section.menuLabel}
              <span className="text-[11px] tabular-nums text-muted-foreground/70">
                {categoryCounts?.[section.category] ??
                  section.connectors.length}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConnectorsToolbarActions({
  activeTab,
  search,
  setSearch,
  showAccessManagement,
  shelfEnabled,
  connectionFilter,
  agents,
  setConnectionFilter,
  isAdmin,
  onCreateCustom,
}: {
  readonly activeTab: "builtin" | "custom";
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly showAccessManagement: boolean;
  readonly shelfEnabled: boolean;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly agents: readonly AgentResponse[];
  readonly setConnectionFilter: (value: ConnectorsConnectionFilter) => void;
  readonly isAdmin: boolean;
  readonly onCreateCustom: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      {activeTab === "builtin" && (
        <div className="relative w-40 sm:w-52">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            type="text"
            placeholder={t(($) => {
              return $.connectors.catalog.search;
            })}
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            className="pl-9 pr-3"
          />
        </div>
      )}
      {activeTab === "builtin" &&
        showAccessManagement &&
        (shelfEnabled ? (
          <ConnectorStatusSegment
            value={connectionFilter}
            onChange={setConnectionFilter}
          />
        ) : (
          <ConnectorFilterDropdown
            value={connectionFilter}
            agents={agents}
            onChange={setConnectionFilter}
          />
        ))}
      {activeTab === "custom" && isAdmin && (
        <Button
          variant="outline"
          size="sm"
          className="okou-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
          onClick={onCreateCustom}
        >
          <Plus size={14} />
          {t(($) => {
            return $.connectors.catalog.newConnector;
          })}
        </Button>
      )}
    </div>
  );
}

function ConnectorCategoryGroupSection({
  group,
  renderCard,
}: {
  group: ConnectorCategoryGroup<PlatformConnectorCatalogStatusItem>;
  renderCard: (connector: PlatformConnectorCatalogStatusItem) => ReactNode;
}) {
  if (group.kind === "group") {
    return (
      <section
        key={group.id}
        id={getConnectorCategorySectionId(group.id)}
        className="scroll-mt-6 flex flex-col gap-4"
        data-testid={`connector-category-${group.id}`}
      >
        <h2 className="text-sm font-medium text-muted-foreground">
          {group.label}
        </h2>
        <div className="flex flex-col gap-5">
          {group.sections.map((section) => {
            return (
              <div
                key={section.category}
                id={getConnectorCategorySectionId(section.category)}
                className="scroll-mt-6 flex flex-col gap-3"
                data-testid={`connector-category-${section.category}`}
              >
                <h3 className="text-xs font-medium text-muted-foreground/80">
                  {section.label}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {section.connectors.map(renderCard)}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  const section = group.sections[0];
  return (
    <section
      key={section.category}
      id={getConnectorCategorySectionId(section.category)}
      className="scroll-mt-6 flex flex-col gap-3"
      data-testid={`connector-category-${section.category}`}
    >
      <h2 className="text-sm font-medium text-muted-foreground">
        {section.label}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {section.connectors.map(renderCard)}
      </div>
    </section>
  );
}

/**
 * The browse view: what you already connected in full, then a shelf per
 * category six deep. Listing every discovered connector under twelve headings
 * puts the same wall of cards in front of someone who came to add one thing.
 */
function ConnectorShelfBrowse({
  connected,
  layout,
  renderCard,
  onOpenCategory,
}: {
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly layout: ConnectorShelfLayout<PlatformConnectorCatalogStatusItem>;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
  readonly onOpenCategory: (category: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {connected.length > 0 && (
        <section
          className="flex flex-col gap-3"
          data-testid="connector-shelf-yours"
        >
          <h2 className="text-sm font-medium text-muted-foreground">
            {t(($) => {
              return $.connectors.catalog.shelf.yours;
            })}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map(renderCard)}
          </div>
        </section>
      )}
      <section className="flex flex-col">
        {layout.shelves.map((shelf) => {
          return (
            <ConnectorShelfSection
              key={shelf.category ?? "head"}
              shelf={shelf}
              columns={3}
              onOpenCategory={onOpenCategory}
            >
              {shelf.connectors.map(renderCard)}
            </ConnectorShelfSection>
          );
        })}
        <ConnectorShelfChips chips={layout.chips} onSelect={onOpenCategory} />
      </section>
    </>
  );
}

/** Category totals ride on the discovery response; absent while it loads. */
function discoveryCategoryCounts(
  catalogStatusLoadable: Loadable<PublicConnectorCatalogDiscoveryResponse>,
): Readonly<Record<string, number>> | undefined {
  return catalogStatusLoadable.state === "hasData"
    ? catalogStatusLoadable.data.categoryConnectorCounts
    : undefined;
}

interface ConnectorsBrowseModel {
  readonly showShelves: boolean;
  readonly layout: ConnectorShelfLayout<PlatformConnectorCatalogStatusItem>;
  readonly connected: readonly PlatformConnectorCatalogStatusItem[];
  readonly chipSections: readonly ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[];
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
}

/**
 * Splits what the page shows into "what you have" and "what you could add".
 * Shelves are built from the unconnected half only, and stand down entirely
 * once a keyword, a category or a status is chosen: that is already a filter,
 * and a shelf on top of it would hide most of what was just asked for.
 */
function buildConnectorsBrowseModel({
  catalogItems,
  allConnectors,
  categoryMetadata,
  categoryCounts,
  otherCategoryLabel,
  headLabel,
  search,
  categoryFilter,
  connectionFilter,
  ready,
}: {
  readonly catalogItems: readonly PlatformConnectorCatalogStatusItem[];
  readonly allConnectors: readonly PlatformConnectorCatalogStatusItem[];
  readonly categoryMetadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly categoryCounts: Readonly<Record<string, number>> | undefined;
  readonly otherCategoryLabel: string;
  readonly headLabel: string;
  readonly search: string;
  readonly categoryFilter: string | null;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly ready: boolean;
}): ConnectorsBrowseModel {
  const filtered =
    search.trim().length > 0 ||
    categoryFilter !== null ||
    connectionFilter.kind !== "all";
  const sectionsOf = (
    items: readonly PlatformConnectorCatalogStatusItem[],
  ): ConnectorCategorySection<PlatformConnectorCatalogStatusItem>[] => {
    return groupConnectorsByCategory(
      items,
      categoryMetadata,
      otherCategoryLabel,
    ).flatMap((group) => {
      return group.sections;
    });
  };
  const layout = buildConnectorShelves({
    sections: sectionsOf(
      catalogItems.filter((connector) => {
        return !connector.connected;
      }),
    ),
    categoryCounts,
    headLabel,
    // The page's card grid is three wide, so six is two whole rows.
    previewSize: 6,
  });
  return {
    // Shelves need something to shelve: a catalog too small for any category to
    // fill one falls through to the plain list.
    showShelves: ready && !filtered && layout.shelves.length > 0,
    layout,
    connected: catalogItems.filter((connector) => {
      return connector.connected;
    }),
    // Chips come from the whole catalog, not the filtered view: a chip row
    // that empties itself when you pick a chip cannot be used to pick another.
    chipSections: sectionsOf(allConnectors),
    categoryCounts,
  };
}

/**
 * The built-in tab. Chips first, because category is the dimension that makes
 * four thousand connectors browsable; then either the shelves or, once the
 * reader has filtered, the plain result list.
 */
function ConnectorsBuiltinPanel({
  browse,
  shelfEnabled,
  categoryFilter,
  setCategoryFilter,
  renderCard,
  fallback,
}: {
  readonly browse: ConnectorsBrowseModel;
  readonly shelfEnabled: boolean;
  readonly categoryFilter: string | null;
  readonly setCategoryFilter: (category: string | null) => void;
  readonly renderCard: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ReactNode;
  readonly fallback: ReactNode;
}) {
  return (
    <>
      {shelfEnabled && (
        <ConnectorCategoryChipRow
          sections={browse.chipSections}
          categoryCounts={browse.categoryCounts}
          selected={categoryFilter}
          onSelect={setCategoryFilter}
        />
      )}
      {browse.showShelves ? (
        <ConnectorShelfBrowse
          connected={browse.connected}
          layout={browse.layout}
          renderCard={renderCard}
          onOpenCategory={setCategoryFilter}
        />
      ) : (
        fallback
      )}
    </>
  );
}

function connectorAgentName(agent: AgentResponse): string {
  return (
    agent.displayName ??
    i18n.t(($) => {
      return $.connectors.catalog.unnamedAgent;
    })
  );
}

function ConnectorAccessButton({
  connectorSlug,
  connectorLabel,
  allowAccessIncrease,
  onClick,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorLabel: string;
  readonly allowAccessIncrease: boolean;
  readonly onClick: () => void;
}) {
  const agentsBySlugLoadable = useLastLoadable(
    connectorAuthorizedAgentsBySlug$,
  );
  const agents =
    agentsBySlugLoadable.state === "hasData"
      ? (agentsBySlugLoadable.data.get(connectorSlug) ?? [])
      : [];
  return (
    <ConnectorAgentAccessButton
      agents={agents}
      status={connectorAgentAccessStatus(agentsBySlugLoadable.state)}
      allowAccessIncrease={allowAccessIncrease}
      connectorLabel={connectorLabel}
      onClick={onClick}
    />
  );
}

function renderBuiltinList({
  loadingState,
  grouped,
  filteredCount,
  renderCard,
  search,
  connectionFilter,
}: {
  loadingState: "loading" | "hasData" | "hasError";
  grouped: ConnectorCategoryGroup<PlatformConnectorCatalogStatusItem>[];
  filteredCount: number;
  renderCard: (connector: PlatformConnectorCatalogStatusItem) => ReactNode;
  search: string;
  connectionFilter: ConnectorsConnectionFilter;
}): ReactNode {
  if (loadingState !== "hasData") {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }, (_, i) => {
          return (
            <div
              key={i}
              data-testid="connector-skeleton"
              className={surfaceVariants({
                className: "flex flex-col animate-pulse",
              })}
            >
              <div className="flex h-14 items-center gap-2.5 px-5">
                <span className="h-5 w-5 shrink-0 rounded-lg bg-muted/50" />
                <span className="h-4 w-24 rounded bg-muted/50" />
              </div>
              <div className="flex h-11 items-center border-t border-border/30 px-5">
                <span className="h-3 w-16 rounded bg-muted/30" />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (filteredCount === 0) {
    const trimmedSearch = search.trim();
    const base =
      connectionFilter.kind === "connected"
        ? i18n.t(($) => {
            return $.connectors.catalog.empty.connected;
          })
        : connectionFilter.kind === "not-connected"
          ? i18n.t(($) => {
              return $.connectors.catalog.empty.notConnected;
            })
          : connectionFilter.kind === "agent"
            ? i18n.t(($) => {
                return $.connectors.catalog.empty.agent;
              })
            : null;
    const message = base
      ? trimmedSearch
        ? i18n.t(
            ($) => {
              return $.connectors.catalog.empty.matching;
            },
            { message: base, search: trimmedSearch },
          )
        : base
      : trimmedSearch
        ? i18n.t(
            ($) => {
              return $.connectors.catalog.empty.search;
            },
            { search: trimmedSearch },
          )
        : null;
    if (!message) {
      return null;
    }
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <img
          src={noConnectorImg}
          alt={i18n.t(($) => {
            return $.connectors.catalog.noConnectorsAlt;
          })}
          className="h-20 w-20 object-contain opacity-80"
        />
        <p className="text-center text-sm text-muted-foreground">{message}</p>
      </div>
    );
  }

  return grouped.map((group) => {
    return (
      <ConnectorCategoryGroupSection
        key={group.id}
        group={group}
        renderCard={renderCard}
      />
    );
  });
}

function connectorLabelForSlug(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
  connectorSlug: ConnectorSlug | null,
): string | null {
  if (!connectorSlug) {
    return null;
  }
  return (
    connectors.find((connector) => {
      return connector.slug === connectorSlug;
    })?.label ?? connectorSlug
  );
}

function effectiveConnectorCatalogCount(
  catalogStatusLoadable: Loadable<PublicConnectorCatalogDiscoveryResponse>,
): number | null {
  if (catalogStatusLoadable.state !== "hasData") {
    return null;
  }
  return catalogStatusLoadable.data.totalConnectorCount;
}

interface SettingsConnectorCardProps {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountSummary: ConnectorAccountSummary | undefined;
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
  readonly busy: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly onManageAccounts: () => void;
  readonly onManageAccess: () => void;
}

interface ConnectorCatalogHeaderProps {
  readonly connectorCatalogCount: number | null;
}

function ConnectorCatalogHeader(props: ConnectorCatalogHeaderProps) {
  const { t } = useTranslation();
  const description =
    props.connectorCatalogCount !== null
      ? t(
          ($) => {
            return $.connectors.catalog.descriptionWithCount;
          },
          { value: formatLocalizedNumber(props.connectorCatalogCount) },
        )
      : t(($) => {
          return $.connectors.catalog.description;
        });
  return (
    <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
      <div className="mx-auto w-full max-w-[900px]">
        <div className="min-w-0 hidden md:block">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.connectors.catalog.title;
            })}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </header>
  );
}

function SettingsConnectorCard(props: SettingsConnectorCardProps) {
  const manageAccess = (
    <ConnectorAccessButton
      connectorSlug={props.connector.slug}
      connectorLabel={props.connector.label}
      allowAccessIncrease={
        props.accountSummaryStatus === "ready" &&
        (props.accountSummary?.accountCount ?? 0) > 0
      }
      onClick={props.onManageAccess}
    />
  );
  return (
    <ConnectorCard
      variant="accounts"
      connector={props.connector}
      summary={props.accountSummary}
      summaryStatus={props.accountSummaryStatus}
      busy={props.busy}
      connect={props.connect}
      onManage={props.onManageAccounts}
      manageAccess={manageAccess}
    />
  );
}

function ManagedConnectorAccessDialog() {
  const connectorSlug = useGet(managedConnectorAccessSlug$);
  const close = useSet(closeConnectorAccessManagement$);
  const catalogItemsLoadable = useLastLoadable(relatedCatalogItems$);
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  if (!connectorSlug || catalogItemsLoadable.state !== "hasData") {
    return null;
  }
  const connectorLabel = connectorLabelForSlug(
    catalogItemsLoadable.data,
    connectorSlug,
  );
  if (!connectorLabel) {
    return null;
  }
  const accountSummary =
    accountSummariesLoadable.state === "hasData"
      ? accountSummariesLoadable.data.get(`builtin:${connectorSlug}`)
      : undefined;
  return (
    <ConnectorAccessManagementDialog
      connectorSlug={connectorSlug}
      connectorLabel={connectorLabel}
      allowAccessIncrease={(accountSummary?.accountCount ?? 0) > 0}
      onClose={close}
    />
  );
}

export function ConnectorsPage() {
  const { t } = useTranslation();
  const relatedCatalogItemsLoadable = useLastLoadable(relatedCatalogItems$);
  const filteredCatalogItemsLoadable = useLastLoadable(
    filteredConnectorCatalogItems$,
  );
  const catalogStatusLoadable = useLastLoadable(connectorCatalogDiscovery$);
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const accountSummaryStatus = connectorAccountSummaryStatus(
    accountSummariesLoadable.state,
  );
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
  const runConnectSuccess = useSet(runConnectorConnectSuccess$);
  const managedAccountConnector = useGet(builtinAccountManager$);
  const accountConnect = useGet(builtinAccountConnectDialog$);
  const openAccountManager = useSet(openBuiltinAccountManager$);
  const closeAccountManager = useSet(closeBuiltinAccountManager$);
  const openAccountConnect = useSet(openBuiltinAccountConnectDialog$);
  const closeAccountConnect = useSet(closeBuiltinAccountConnectDialog$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const signal = useGet(pageSignal$);
  const scopeReviewSelection = useGet(scopeReviewSelection$);
  const setScopeReviewSelection = useSet(setScopeReviewSelection$);
  const setManagedConnectorSlug = useSet(setManagedConnectorAccessSlug$);
  const activeTab = useGet(connectorsPageTab$);
  const shelfEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorDirectory] === true;
  const setActiveTab = useSet(setConnectorsPageTab$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openCreateCustom = useSet(openCustomConnectorCreateDialog$);
  const activeCategoryId = useGet(activeConnectorCategoryId$);
  const attachScrollTracking = useSet(attachConnectorCategoryScrollTracking$);
  const resetActiveCategory = useSet(resetActiveConnectorCategory$);
  const categoryTrackingEnabled =
    !shelfEnabled &&
    activeTab === "builtin" &&
    filteredCatalogItemsLoadable.state === "hasData";
  const scrollContainerRef = useScrollTrackingRef(
    categoryTrackingEnabled,
    attachScrollTracking,
    resetActiveCategory,
  );

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);
  const connectionFilter = useGet(connectorsConnectionFilter$);
  const setConnectionFilter = useSet(setConnectorsConnectionFilter$);
  const categoryFilter = useGet(connectorsCategoryFilter$);
  const setCategoryFilter = useSet(setConnectorsCategoryFilter$);
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const filteredConnectors =
    filteredCatalogItemsLoadable.state === "hasData"
      ? filteredCatalogItemsLoadable.data
      : [];
  const connectorCatalogCount = effectiveConnectorCatalogCount(
    catalogStatusLoadable,
  );
  const categoryMetadata = localizeConnectorCategoryMetadata(
    catalogStatusLoadable.state === "hasData"
      ? catalogStatusLoadable.data.categoryMetadata
      : undefined,
  );
  const allConnectors =
    relatedCatalogItemsLoadable.state === "hasData"
      ? relatedCatalogItemsLoadable.data
      : [];
  const finishExplicitAccountAdd = async (
    connector: PlatformConnectorCatalogStatusItem,
    connectionId: string | null,
  ): Promise<void> => {
    await runConnectSuccess(
      connector.slug,
      (completedConnectionId) => {
        return finishAccountConnection(
          {
            target: { kind: "builtin", connectorSlug: connector.slug },
            connectionId: completedConnectionId,
            connectorLabel: connector.label,
            mode: { kind: "add" },
          },
          signal,
        );
      },
      connectionId,
      signal,
    );
  };

  const accountConnectHandlers = (
    connector: PlatformConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    return {
      openModal: () => {
        openAccountConnect(connector, { kind: "add" });
      },
      connectBrowserAuth: async (authMethod) => {
        const result = await connect(
          connector.slug,
          authMethod,
          {
            account: { intent: "add" },
            authorizeVisibleAgents: true,
            connectorLabel: connector.label,
            connectorIcon: connector.icon,
          },
          signal,
        );
        if (result) {
          await finishExplicitAccountAdd(connector, result.connectionId);
        }
        return result;
      },
      connectNoAuth: async (authMethod) => {
        const result = await connectNoAuth(
          {
            connectorSlug: connector.slug,
            authMethod,
            options: {
              account: { intent: "add" },
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
            },
          },
          signal,
        );
        if (result) {
          await finishExplicitAccountAdd(connector, result.connectionId);
        }
        return result;
      },
    };
  };

  const renderCard = (c: PlatformConnectorCatalogStatusItem) => {
    const isPolling =
      pollingAuthCodeSlug === c.slug ||
      pollingDeviceAuthSlug === c.slug ||
      connectFlowSlug === c.slug;
    const summary =
      accountSummariesLoadable.state === "hasData"
        ? accountSummariesLoadable.data.get(`builtin:${c.slug}`)
        : undefined;
    return (
      <SettingsConnectorCard
        key={c.slug}
        connector={c}
        accountSummary={summary}
        accountSummaryStatus={accountSummaryStatus}
        busy={isPolling}
        connect={accountConnectHandlers(c)}
        onManageAccounts={() => {
          return openAccountManager(c, signal);
        }}
        onManageAccess={() => {
          return setManagedConnectorSlug(c.slug);
        }}
      />
    );
  };

  const otherCategoryLabel = t(($) => {
    return $.connectors.catalog.otherCategory;
  });
  const grouped = groupConnectorsByCategory(
    filteredConnectors,
    categoryMetadata,
    otherCategoryLabel,
  );
  const browse = buildConnectorsBrowseModel({
    catalogItems: filteredConnectors,
    allConnectors,
    categoryMetadata,
    categoryCounts: discoveryCategoryCounts(catalogStatusLoadable),
    otherCategoryLabel,
    headLabel: t(($) => {
      return $.connectors.catalog.shelf.popular;
    }),
    search,
    categoryFilter,
    connectionFilter,
    ready: shelfEnabled && filteredCatalogItemsLoadable.state === "hasData",
  });

  const builtinList = renderBuiltinList({
    loadingState: filteredCatalogItemsLoadable.state,
    grouped,
    filteredCount: filteredConnectors.length,
    renderCard,
    search,
    connectionFilter,
  });
  return (
    <div
      ref={scrollContainerRef}
      data-testid="connectors-scroll-viewport"
      className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]"
    >
      <ConnectorCatalogHeader connectorCatalogCount={connectorCatalogCount} />

      <main
        data-testid="connectors-scroll-content"
        className="flex-1 px-4 sm:px-6 pt-3 pb-[max(4rem,var(--sab))]"
      >
        <div className="relative mx-auto w-full max-w-[900px]">
          {!shelfEnabled &&
            activeTab === "builtin" &&
            filteredCatalogItemsLoadable.state === "hasData" && (
              <ConnectorCategoryMenu
                activeCategoryId={activeCategoryId}
                groups={grouped}
              />
            )}

          <div className="min-w-0 flex w-full max-w-[900px] flex-col gap-6">
            <div className="flex items-center justify-between gap-3">
              <Tabs
                value={activeTab}
                onValueChange={(v) => {
                  return setActiveTab(v === "custom" ? "custom" : "builtin");
                }}
              >
                <TabsList>
                  <TabsTrigger value="builtin">
                    {t(($) => {
                      return $.connectors.catalog.tabs.builtin;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="custom">
                    {t(($) => {
                      return $.connectors.catalog.tabs.custom;
                    })}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <ConnectorsToolbarActions
                activeTab={activeTab}
                search={search}
                setSearch={setSearch}
                shelfEnabled={shelfEnabled}
                showAccessManagement
                connectionFilter={connectionFilter}
                agents={agents}
                setConnectionFilter={setConnectionFilter}
                isAdmin={isAdmin}
                onCreateCustom={openCreateCustom}
              />
            </div>

            {activeTab === "builtin" && (
              <ConnectorsBuiltinPanel
                browse={browse}
                shelfEnabled={shelfEnabled}
                categoryFilter={categoryFilter}
                setCategoryFilter={setCategoryFilter}
                renderCard={renderCard}
                fallback={builtinList}
              />
            )}

            {activeTab === "custom" && <CustomConnectorsPanel />}
          </div>
        </div>
      </main>

      {accountConnect && (
        <ConnectModal
          item={accountConnect.connector}
          authorizeVisibleAgentsOnConnect
          accountMode={accountConnect.mode}
          accountOptions={{
            account:
              accountConnect.mode.kind === "add"
                ? { intent: "add" }
                : {
                    intent: "reconnect",
                    connectionId: accountConnect.mode.connectionId,
                  },
          }}
          onClose={() => {
            closeAccountConnect();
          }}
          onSuccess={async (connectionId) => {
            await finishAccountConnection(
              {
                target: {
                  kind: "builtin",
                  connectorSlug: accountConnect.connector.slug,
                },
                connectionId,
                connectorLabel: accountConnect.connector.label,
                mode: accountConnect.mode,
              },
              signal,
            );
          }}
        />
      )}

      {managedAccountConnector && (
        <ConnectorAccountManagerDialog
          target={{
            kind: "builtin",
            connectorSlug: managedAccountConnector.slug,
          }}
          connectorLabel={managedAccountConnector.label}
          icon={<ConnectorIcon icon={managedAccountConnector.icon} size={20} />}
          connectionActionsEnabled
          onClose={() => {
            closeAccountManager();
          }}
          onAdd={() => {
            closeAccountManager();
            launchConnectorConnect({
              connector: managedAccountConnector,
              ...accountConnectHandlers(managedAccountConnector),
            });
          }}
          onReconnect={(account) => {
            openAccountConnect(managedAccountConnector, {
              kind: "reconnect",
              connectionId: account.id,
              authMethod: account.authMethod,
            });
          }}
          onReviewScopes={(account) => {
            closeAccountManager();
            setScopeReviewSelection({
              connectorSlug: managedAccountConnector.slug,
              connectionId: account.id,
              authMethod: account.authMethod,
            });
          }}
        />
      )}

      {scopeReviewSelection && (
        <ScopeReviewModal
          selection={scopeReviewSelection}
          onClose={() => {
            return setScopeReviewSelection(null);
          }}
          onReconnect={(selection) => {
            setScopeReviewSelection(null);
            const connector = allConnectors.find((connector) => {
              return connector.slug === selection.connectorSlug;
            });
            if (connector) {
              openAccountConnect(connector, {
                kind: "reconnect",
                connectionId: selection.connectionId,
                authMethod: selection.authMethod,
              });
            }
          }}
        />
      )}
      <ConnectorAccountNameDialog />

      <ManagedConnectorAccessDialog />
    </div>
  );
}
