// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconSearch,
  IconPlus,
  IconFilter,
  IconChevronDown,
  IconCheck,
} from "@tabler/icons-react";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import {
  connectorsPageTab$,
  setConnectorsPageTab$,
  openCustomConnectorCreateDialog$,
} from "../../signals/zero-page/settings/custom-connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { agents$ } from "../../signals/agent.ts";
import { CustomConnectorsPanel } from "./components/settings/custom-connectors-panel.tsx";
import {
  allConnectorCatalogItems$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowConnectorSlug$,
  connectorsSearch$,
  connectorsConnectionFilter$,
  disconnectConnector$,
  filteredConnectorCatalogItems$,
  setConnectorsConnectionFilter$,
  setConnectorsSearch$,
  selectedConnectorSlug$,
  setSelectedConnectorSlug$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  justConnectedSlugs$,
  scopeReviewConnectorSlug$,
  setScopeReviewConnectorSlug$,
  getAvailableStatusAuthCodeAuthMethod,
  getConnectorStatusAuthMethod,
  type ConnectorsConnectionFilter,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  activeConnectorCategoryId$,
  attachConnectorCategoryScrollTracking$,
  getConnectorCategorySectionId,
  groupConnectorsByCategory,
  resetActiveConnectorCategory$,
  scrollToConnectorCategory,
  type ConnectorCategoryGroup,
} from "../../signals/zero-page/settings/connector-categories.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { ConnectorCard } from "./components/settings/connector-card.tsx";
import type { ConnectorConnectHandlers } from "./components/settings/launch-connector-connect.ts";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { ConnectorAccessManagementDialog } from "./components/settings/connector-access-management-dialog.tsx";
import {
  closeConnectorAccessManagement$,
  connectorAuthorizedAgentsBySlug$,
  managedConnectorAccessSlug$,
  setManagedConnectorAccessSlug$,
} from "../../signals/zero-page/settings/connector-access-management.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { noConnectorImg } from "./platform-assets.ts";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vm0/ui";

const CONNECTOR_CARD_AGENT_NAME_LIMIT = 2;
const CONNECTOR_CARD_AGENT_NAME_MAX_CHARS = 12;

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
  groups: readonly ConnectorCategoryGroup<PublicConnectorCatalogStatusItem>[];
}) {
  if (groups.length <= 1) {
    return null;
  }

  return (
    <aside className="pointer-events-none fixed right-6 top-[28vh] z-20 hidden w-44 min-[1332px]:block">
      <nav
        aria-label="Connector categories"
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
      {active && (
        <IconCheck size={15} stroke={2} className="shrink-0 text-foreground" />
      )}
    </DropdownMenuItem>
  );
}

function connectorFilterTriggerLabel(
  value: ConnectorsConnectionFilter,
  activeAgent: TeamComposeItem | undefined,
): string {
  if (value.kind === "connected") {
    return "Connected";
  }
  if (value.kind === "not-connected") {
    return "Not connected";
  }
  if (value.kind === "agent" && activeAgent) {
    return connectorAgentName(activeAgent);
  }
  return "All";
}

function ConnectorFilterDropdown({
  value,
  agents,
  onChange,
}: {
  readonly value: ConnectorsConnectionFilter;
  readonly agents: readonly TeamComposeItem[];
  readonly onChange: (value: ConnectorsConnectionFilter) => void;
}) {
  const activeAgent =
    value.kind === "agent"
      ? agents.find((agent) => {
          return agent.id === value.agentId;
        })
      : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Filter connectors"
          className="zero-btn-morandi hidden h-9 shrink-0 gap-1.5 rounded-lg border sm:inline-flex"
        >
          <IconFilter
            size={14}
            stroke={1.5}
            className="text-muted-foreground"
          />
          {activeAgent && (
            <AvatarFromUrl
              avatarUrl={activeAgent.avatarUrl}
              alt={connectorAgentName(activeAgent)}
              size={16}
              className="h-4 w-4 rounded-full object-cover"
            />
          )}
          <span className="max-w-[140px] truncate">
            {connectorFilterTriggerLabel(value, activeAgent)}
          </span>
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-56 overflow-y-auto"
      >
        <ConnectorFilterOption
          active={value.kind === "all"}
          onSelect={() => {
            onChange({ kind: "all" });
          }}
        >
          All
        </ConnectorFilterOption>
        <DropdownMenuSeparator />
        <ConnectorFilterSectionLabel>Status</ConnectorFilterSectionLabel>
        <ConnectorFilterOption
          active={value.kind === "connected"}
          onSelect={() => {
            onChange({ kind: "connected" });
          }}
        >
          Connected
        </ConnectorFilterOption>
        <ConnectorFilterOption
          active={value.kind === "not-connected"}
          onSelect={() => {
            onChange({ kind: "not-connected" });
          }}
        >
          Not connected
        </ConnectorFilterOption>
        {agents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <ConnectorFilterSectionLabel>Agents</ConnectorFilterSectionLabel>
            {agents.map((agent) => {
              return (
                <ConnectorFilterOption
                  key={agent.id}
                  active={value.kind === "agent" && value.agentId === agent.id}
                  onSelect={() => {
                    onChange({ kind: "agent", agentId: agent.id });
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

function ConnectorsToolbarActions({
  activeTab,
  search,
  setSearch,
  showAccessManagement,
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
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly agents: readonly TeamComposeItem[];
  readonly setConnectionFilter: (value: ConnectorsConnectionFilter) => void;
  readonly isAdmin: boolean;
  readonly onCreateCustom: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {activeTab === "builtin" && (
        <div className="relative w-40 sm:w-52">
          <IconSearch
            size={15}
            stroke={1.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <input
            type="text"
            placeholder="Find connectors"
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10"
          />
        </div>
      )}
      {activeTab === "builtin" && showAccessManagement && (
        <ConnectorFilterDropdown
          value={connectionFilter}
          agents={agents}
          onChange={setConnectionFilter}
        />
      )}
      {activeTab === "custom" && isAdmin && (
        <Button
          variant="outline"
          size="sm"
          className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
          onClick={onCreateCustom}
        >
          <IconPlus size={14} stroke={2} />
          New connector
        </Button>
      )}
    </div>
  );
}

function ConnectorCategoryGroupSection({
  group,
  renderCard,
}: {
  group: ConnectorCategoryGroup<PublicConnectorCatalogStatusItem>;
  renderCard: (connector: PublicConnectorCatalogStatusItem) => ReactNode;
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

function connectorAgentName(agent: TeamComposeItem): string {
  return agent.displayName ?? "Unnamed";
}

function truncateAgentName(name: string): string {
  if (name.length <= CONNECTOR_CARD_AGENT_NAME_MAX_CHARS) {
    return name;
  }
  return `${name.slice(0, CONNECTOR_CARD_AGENT_NAME_MAX_CHARS - 1)}…`;
}

function ConnectorAccessButton({
  connectorSlug,
  connectorLabel,
  onClick,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly connectorLabel: string;
  readonly onClick: () => void;
}) {
  const agentsBySlugLoadable = useLastLoadable(
    connectorAuthorizedAgentsBySlug$,
  );
  const agents =
    agentsBySlugLoadable.state === "hasData"
      ? (agentsBySlugLoadable.data.get(connectorSlug) ?? [])
      : [];
  const loading = agentsBySlugLoadable.state === "loading";
  const visibleNames = agents
    .slice(0, CONNECTOR_CARD_AGENT_NAME_LIMIT)
    .map((agent) => {
      return truncateAgentName(connectorAgentName(agent));
    });
  const overflowCount = agents.length - visibleNames.length;

  return (
    <button
      type="button"
      className="inline-flex h-7 min-w-0 shrink items-center gap-0 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--gray-50))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={`Manage ${connectorLabel} access`}
      onClick={onClick}
    >
      {loading ? (
        <span className="block h-3 w-20 animate-pulse rounded bg-muted" />
      ) : agents.length === 0 ? (
        <span
          className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
          data-testid="connector-card-access-empty"
        >
          Add access
        </span>
      ) : (
        <>
          <span className="shrink-0">Used by&nbsp;</span>
          <span
            className="min-w-0 truncate underline decoration-dotted decoration-muted-foreground/40 underline-offset-2"
            data-testid="connector-card-access-names"
          >
            {visibleNames.join(", ")}
          </span>
          {overflowCount > 0 && (
            <span className="ml-0.5 shrink-0 text-muted-foreground/70">
              +{overflowCount}
            </span>
          )}
        </>
      )}
    </button>
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
  grouped: ConnectorCategoryGroup<PublicConnectorCatalogStatusItem>[];
  filteredCount: number;
  renderCard: (connector: PublicConnectorCatalogStatusItem) => ReactNode;
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
              className="zero-card flex flex-col animate-pulse"
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
        ? "No connected connectors"
        : connectionFilter.kind === "not-connected"
          ? "No connectors left to connect"
          : connectionFilter.kind === "agent"
            ? "No connectors for this agent"
            : null;
    const message = base
      ? trimmedSearch
        ? `${base} matching "${trimmedSearch}"`
        : base
      : trimmedSearch
        ? `No connectors matching "${trimmedSearch}"`
        : null;
    if (!message) {
      return null;
    }
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <img
          src={noConnectorImg}
          alt="No connectors"
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
  connectors: readonly PublicConnectorCatalogStatusItem[],
  connectorSlug: ConnectorSlug | null,
): string | null {
  if (!connectorSlug) {
    return null;
  }
  return (
    connectors.find((connector) => {
      return connector.connectorRef === connectorSlug;
    })?.label ?? connectorSlug
  );
}

export function ZeroConnectorsPage() {
  const allCatalogItemsLoadable = useLastLoadable(allConnectorCatalogItems$);
  const filteredCatalogItemsLoadable = useLastLoadable(
    filteredConnectorCatalogItems$,
  );
  const catalogStatusLoadable = useLastLoadable(connectorCatalogStatus$);
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectConnector$);
  const signal = useGet(pageSignal$);
  const selectedConnectorSlug = useGet(selectedConnectorSlug$);
  const setSelected = useSet(setSelectedConnectorSlug$);
  const scopeReviewConnectorSlug = useGet(scopeReviewConnectorSlug$);
  const setScopeReviewConnectorSlug = useSet(setScopeReviewConnectorSlug$);
  const managedConnectorSlug = useGet(managedConnectorAccessSlug$);
  const setManagedConnectorSlug = useSet(setManagedConnectorAccessSlug$);
  const closeManagedConnector = useSet(closeConnectorAccessManagement$);
  const optimisticConnected = useGet(justConnectedSlugs$);
  const activeTab = useGet(connectorsPageTab$);
  const setActiveTab = useSet(setConnectorsPageTab$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openCreateCustom = useSet(openCustomConnectorCreateDialog$);
  const activeCategoryId = useGet(activeConnectorCategoryId$);
  const attachScrollTracking = useSet(attachConnectorCategoryScrollTracking$);
  const resetActiveCategory = useSet(resetActiveConnectorCategory$);
  const categoryTrackingEnabled =
    activeTab === "builtin" && filteredCatalogItemsLoadable.state === "hasData";
  const scrollContainerRef = useScrollTrackingRef(
    categoryTrackingEnabled,
    attachScrollTracking,
    resetActiveCategory,
  );

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);
  const connectionFilter = useGet(connectorsConnectionFilter$);
  const setConnectionFilter = useSet(setConnectorsConnectionFilter$);
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const filteredConnectors =
    filteredCatalogItemsLoadable.state === "hasData"
      ? filteredCatalogItemsLoadable.data
      : [];
  const categoryMetadata =
    catalogStatusLoadable.state === "hasData"
      ? catalogStatusLoadable.data.categoryMetadata
      : undefined;
  const allConnectors =
    allCatalogItemsLoadable.state === "hasData"
      ? allCatalogItemsLoadable.data
      : [];
  const managedConnectorLabel = connectorLabelForSlug(
    allConnectors,
    managedConnectorSlug,
  );
  const disconnecting = disconnectLoadable.state === "loading";

  const connectHandlers = (
    connector: PublicConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    return {
      openModal: () => {
        setSelected(connector.connectorRef);
      },
      connectBrowserAuth: (authMethod) => {
        return connect(
          connector.connectorRef,
          authMethod,
          {
            authorizeVisibleAgents: true,
            connectorLabel: connector.label,
            connectorIcon: connector.icon,
          },
          signal,
        );
      },
      connectNoAuth: (authMethod) => {
        return connectNoAuth(
          {
            connectorSlug: connector.connectorRef,
            authMethod,
            options: {
              authorizeVisibleAgents: true,
              connectorLabel: connector.label,
            },
          },
          signal,
        );
      },
    };
  };

  const disconnectHandler = async (
    connectorSlug: ConnectorSlug,
    connectorLabel: string,
  ) => {
    if (disconnecting) {
      return;
    }
    await disconnect(connectorSlug, connectorLabel, signal);
  };

  const renderCard = (c: PublicConnectorCatalogStatusItem) => {
    const isConnected = c.connected || optimisticConnected.has(c.connectorRef);
    const isPolling =
      pollingAuthCodeSlug === c.connectorRef ||
      pollingDeviceAuthSlug === c.connectorRef ||
      connectFlowSlug === c.connectorRef;
    if (!isConnected) {
      return (
        <ConnectorCard
          key={c.connectorRef}
          variant="catalog"
          connector={c}
          busy={isPolling}
          connect={connectHandlers(c)}
        />
      );
    }
    return (
      <ConnectorCard
        key={c.connectorRef}
        variant="connection"
        connector={c}
        connected={isConnected}
        busy={isPolling}
        disconnecting={disconnecting}
        connect={connectHandlers(c)}
        onDisconnect={() => {
          detach(
            disconnectHandler(c.connectorRef, c.label),
            Reason.DomCallback,
          );
        }}
        manageAccess={
          <ConnectorAccessButton
            connectorSlug={c.connectorRef}
            connectorLabel={c.label}
            onClick={() => {
              setManagedConnectorSlug(c.connectorRef);
            }}
          />
        }
        onReviewScopes={() => {
          return setScopeReviewConnectorSlug(c.connectorRef);
        }}
      />
    );
  };

  const grouped = groupConnectorsByCategory(
    filteredConnectors,
    categoryMetadata,
  );

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
      className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]"
    >
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="min-w-0 hidden md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Connectors
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Connect third-party services for your agents to use.
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 pt-3 pb-16">
        <div className="relative mx-auto w-full max-w-[900px]">
          {activeTab === "builtin" &&
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
                  <TabsTrigger value="builtin">Built-in</TabsTrigger>
                  <TabsTrigger value="custom">Custom</TabsTrigger>
                </TabsList>
              </Tabs>
              <ConnectorsToolbarActions
                activeTab={activeTab}
                search={search}
                setSearch={setSearch}
                showAccessManagement
                connectionFilter={connectionFilter}
                agents={agents}
                setConnectionFilter={setConnectionFilter}
                isAdmin={isAdmin}
                onCreateCustom={openCreateCustom}
              />
            </div>

            {activeTab === "builtin" && builtinList}

            {activeTab === "custom" && <CustomConnectorsPanel />}
          </div>
        </div>
      </main>

      {selectedConnectorSlug && (
        <ConnectModal
          authorizeVisibleAgentsOnConnect
          onClose={() => {
            return setSelected(null);
          }}
          onSuccess={() => {
            const label =
              allConnectors.find((c) => {
                return c.connectorRef === selectedConnectorSlug;
              })?.label ?? selectedConnectorSlug;
            toast.success(`${label} connected`);
          }}
        />
      )}

      {scopeReviewConnectorSlug && (
        <ScopeReviewModal
          connectorSlug={scopeReviewConnectorSlug}
          onClose={() => {
            return setScopeReviewConnectorSlug(null);
          }}
          onReconnect={(connectorSlug) => {
            setScopeReviewConnectorSlug(null);
            const connector = allConnectors.find((connector) => {
              return connector.connectorRef === connectorSlug;
            });
            const connection = connector?.connection ?? null;
            if (!connector || !connection) {
              setSelected(connectorSlug);
              return;
            }
            const authMethodId = getAvailableStatusAuthCodeAuthMethod(
              connector,
              connection.authMethod,
            );
            const authMethod = authMethodId
              ? getConnectorStatusAuthMethod(connector, authMethodId)
              : null;
            if (!authMethod) {
              setSelected(connectorSlug);
              return;
            }
            detach(
              connect(
                connectorSlug,
                authMethod,
                {
                  authorizeVisibleAgents: true,
                  connectorLabel: connector.label,
                  connectorIcon: connector.icon,
                },
                signal,
              ),
              Reason.DomCallback,
            );
          }}
        />
      )}

      {managedConnectorSlug && managedConnectorLabel && (
        <ConnectorAccessManagementDialog
          connectorSlug={managedConnectorSlug}
          connectorLabel={managedConnectorLabel}
          onClose={closeManagedConnector}
        />
      )}
    </div>
  );
}
