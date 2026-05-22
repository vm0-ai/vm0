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
  IconPlug,
  IconPlus,
  IconLoader2,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isGoogleOAuthConnector } from "@vm0/connectors/connector-utils";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import {
  connectorsPageTab$,
  setConnectorsPageTab$,
  openCustomConnectorCreateDialog$,
} from "../../signals/zero-page/settings/custom-connectors.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { CustomConnectorsPanel } from "./components/settings/custom-connectors-panel.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  allConnectorTypes$,
  connectConnectorOAuthAuthCode$,
  connectorsSearch$,
  disconnectConnector$,
  setConnectorsSearch$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  pollingOAuthAuthCodeConnectorType$,
  pollingOAuthDeviceAuthConnectorType$,
  justConnectedTypes$,
  LOCAL_AGENT_CONNECTOR_TYPE,
  LOCAL_BROWSER_CONNECTOR_TYPE,
  getLocalBrowserOnlineHosts,
  scopeReviewType$,
  setScopeReviewType$,
  permissionDialogType$,
  setPermissionDialogType$,
  isStandaloneMode,
  matchesConnectorSearch,
  getConfiguredConnectorAuthMethods,
  getConnectorConnectLaunchMode,
  type ConnectorTypeWithStatus,
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
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { ConnectorPermissionDialog } from "./components/settings/connector-permission-dialog.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import noConnectorImg from "./assets/no-connector.webp";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";

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
  groups: readonly ConnectorCategoryGroup<ConnectorTypeWithStatus>[];
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

function ConnectorCategoryGroupSection({
  group,
  renderCard,
}: {
  group: ConnectorCategoryGroup<ConnectorTypeWithStatus>;
  renderCard: (connector: ConnectorTypeWithStatus) => ReactNode;
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

type HostStatusInfo = {
  readonly names: readonly string[];
  readonly emptyLabel: string;
};

function getHostStatusInfo(
  connector: ConnectorTypeWithStatus,
): HostStatusInfo | null {
  if (connector.type === LOCAL_AGENT_CONNECTOR_TYPE) {
    return {
      names: (connector.localAgentHosts ?? []).map((host) => {
        return host.displayName;
      }),
      emptyLabel: "No online hosts",
    };
  }

  if (connector.type === LOCAL_BROWSER_CONNECTOR_TYPE) {
    return {
      names: getLocalBrowserOnlineHosts(connector.localBrowserHosts ?? []).map(
        (host) => {
          return `${host.displayName} (${host.browser})`;
        },
      ),
      emptyLabel: "No browser online",
    };
  }

  return null;
}

function HostBackedConnectorStatus({ info }: { info: HostStatusInfo }) {
  const visibleNames = info.names.slice(0, 2).join(", ");
  const extra = info.names.length > 2 ? ` +${info.names.length - 2}` : "";
  const hasOnlineHosts = info.names.length > 0;
  const label = !hasOnlineHosts
    ? info.emptyLabel
    : `${visibleNames}${extra} online`;

  return (
    <span
      className="flex items-center gap-2 text-xs text-muted-foreground truncate"
      title={hasOnlineHosts ? info.names.join(", ") : info.emptyLabel}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
          hasOnlineHosts ? "bg-emerald-500" : "bg-muted-foreground/40"
        }`}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function GlobalConnectorCard({
  connector,
  isPolling,
  onConnect,
  onDisconnect,
  onReviewScopes,
  isDisconnecting,
}: {
  connector: ConnectorTypeWithStatus;
  isPolling: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onReviewScopes?: () => void;
  isDisconnecting: boolean;
}) {
  const status = (() => {
    if (isPolling) {
      const standaloneHint = isStandaloneMode()
        ? " Switch back here after completing sign-in."
        : "";
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
          {`Connecting…${standaloneHint}`}
        </span>
      );
    }
    if (connector.connected && connector.needsReconnect) {
      return (
        <span className="flex items-center gap-2 text-xs truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="text-amber-600 dark:text-amber-400">
            Connection expired
          </span>
          <button
            type="button"
            onClick={onConnect}
            className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
          >
            Reconnect
          </button>
        </span>
      );
    }
    if (connector.connected && connector.scopeMismatch) {
      return (
        <span className="flex items-center gap-2 text-xs truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="text-amber-600 dark:text-amber-400">
            Permissions update available
          </span>
          <button
            type="button"
            onClick={onReviewScopes}
            className="font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
          >
            Review
          </button>
        </span>
      );
    }
    if (connector.connected) {
      const hostStatusInfo = getHostStatusInfo(connector);
      if (hostStatusInfo) {
        return <HostBackedConnectorStatus info={hostStatusInfo} />;
      }
      return (
        <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span className="truncate">
            {connector.connector?.externalUsername
              ? `@${connector.connector.externalUsername}`
              : "Connected"}
          </span>
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={onConnect}
        className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        Connect
      </button>
    );
  })();

  return (
    <div className="zero-card flex flex-col">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {connector.type in CONNECTOR_TYPES ? (
            <ConnectorIcon type={connector.type} size={20} />
          ) : (
            <IconPlug
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
          )}
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 text-sm font-medium text-foreground truncate"
        >
          {connector.label}
        </span>
      </div>
      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex items-center gap-2 min-w-0">{status}</div>
        {connector.connected && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                aria-label="More options"
              >
                <IconDotsVertical size={14} stroke={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={onDisconnect}
                disabled={isDisconnecting}
              >
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function AvailableConnectorCard({
  connector,
  isPolling,
  onConnect,
}: {
  connector: ConnectorTypeWithStatus;
  isPolling: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Connect ${connector.label}`}
      className="zero-card cursor-pointer overflow-hidden"
      onClick={onConnect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onConnect();
        }
      }}
    >
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {connector.type in CONNECTOR_TYPES ? (
            <ConnectorIcon type={connector.type} size={20} />
          ) : (
            <IconPlug
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
          )}
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 text-sm font-medium text-foreground truncate"
        >
          {connector.label}
        </span>
        {isPolling ? (
          <span
            className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground"
            aria-hidden="true"
          >
            <IconLoader2 size={16} stroke={1.5} className="animate-spin" />
          </span>
        ) : (
          <span
            className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
            aria-hidden="true"
          >
            <IconPlus size={14} stroke={1.5} />
          </span>
        )}
      </div>
      <div className="px-5 pb-4 pt-1">
        <div
          data-testid="connector-help-text"
          className="text-xs text-muted-foreground line-clamp-2"
        >
          {isGoogleOAuthConnector(connector.type) ? (
            <>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-medium text-muted-foreground cursor-default underline decoration-dotted underline-offset-2 decoration-muted-foreground/40">
                      Early Access
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className="max-w-xs text-xs leading-relaxed"
                  >
                    Our Google OAuth is under Google&apos;s verification review.
                    This is a standard compliance step and does not affect
                    vm0&apos;s functionality or security. You can safely proceed
                    by clicking &quot;Continue&quot;.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {connector.helpText && <span>: {connector.helpText}</span>}
            </>
          ) : (
            (connector.helpText ?? "")
          )}
        </div>
      </div>
    </div>
  );
}

function renderBuiltinList({
  loadingState,
  showConnectorCategories,
  grouped,
  filtered,
  renderCard,
  search,
}: {
  loadingState: "loading" | "hasData" | "hasError";
  showConnectorCategories: boolean;
  grouped: ConnectorCategoryGroup<ConnectorTypeWithStatus>[];
  filtered: ConnectorTypeWithStatus[];
  renderCard: (connector: ConnectorTypeWithStatus) => ReactNode;
  search: string;
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

  if (filtered.length === 0 && search) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <img
          src={noConnectorImg}
          alt="No connectors"
          className="h-20 w-20 object-contain opacity-80"
        />
        <p className="text-center text-sm text-muted-foreground">
          No connectors matching &ldquo;{search}&rdquo;
        </p>
      </div>
    );
  }

  if (showConnectorCategories) {
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

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {filtered.map(renderCard)}
    </div>
  );
}

export function ZeroConnectorsPage() {
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingAuthCodeType = useGet(pollingOAuthAuthCodeConnectorType$);
  const pollingDeviceAuthType = useGet(pollingOAuthDeviceAuthConnectorType$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectConnector$);
  const signal = useGet(pageSignal$);
  const selectedType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);
  const scopeReviewType = useGet(scopeReviewType$);
  const setScopeReviewType = useSet(setScopeReviewType$);
  const permissionDialogType = useGet(permissionDialogType$);
  const setPermissionDialogType = useSet(setPermissionDialogType$);
  const optimisticConnected = useGet(justConnectedTypes$);
  const activeTab = useGet(connectorsPageTab$);
  const setActiveTab = useSet(setConnectorsPageTab$);
  const isAdmin = useLastResolved(isOrgAdmin$) ?? false;
  const openCreateCustom = useSet(openCustomConnectorCreateDialog$);
  const activeCategoryId = useGet(activeConnectorCategoryId$);
  const attachScrollTracking = useSet(attachConnectorCategoryScrollTracking$);
  const resetActiveCategory = useSet(resetActiveConnectorCategory$);
  const features = useLastResolved(featureSwitch$);
  const showConnectorCategories =
    features?.[FeatureSwitchKey.ConnectorCategories] ?? false;
  const categoryTrackingEnabled =
    activeTab === "builtin" &&
    allTypesLoadable.state === "hasData" &&
    showConnectorCategories;
  const scrollContainerRef = useScrollTrackingRef(
    categoryTrackingEnabled,
    attachScrollTracking,
    resetActiveCategory,
  );

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const disconnecting = disconnectLoadable.state === "loading";

  const filtered = allConnectors.filter((c) => {
    return matchesConnectorSearch(search, c);
  });

  const connectHandler = (type: ConnectorType) => {
    const ct = allConnectors.find((c) => {
      return c.type === type;
    });
    const launchMode = getConnectorConnectLaunchMode({
      type,
      availableAuthMethods:
        ct?.availableAuthMethods ?? getConfiguredConnectorAuthMethods(type),
      preferModalForGoogleOAuth: true,
    });
    if (launchMode === "modal") {
      setSelected(type);
    } else {
      detach(
        connect(type, { showPermissionDialog: true }, signal),
        Reason.DomCallback,
      );
    }
  };

  const disconnectHandler = onDomEventFn(async (type: ConnectorType) => {
    if (disconnecting) {
      return;
    }
    await disconnect(type, signal);
  });

  const getEffective = (c: ConnectorTypeWithStatus) => {
    return optimisticConnected.has(c.type) && !c.connected
      ? { ...c, connected: true }
      : c;
  };

  const renderCard = (c: ConnectorTypeWithStatus) => {
    const effectiveConnector = getEffective(c);
    const isPolling =
      pollingAuthCodeType === c.type || pollingDeviceAuthType === c.type;
    if (!effectiveConnector.connected) {
      return (
        <AvailableConnectorCard
          key={c.type}
          connector={effectiveConnector}
          isPolling={isPolling}
          onConnect={() => {
            return connectHandler(c.type);
          }}
        />
      );
    }
    return (
      <GlobalConnectorCard
        key={c.type}
        connector={effectiveConnector}
        isPolling={isPolling}
        isDisconnecting={disconnecting}
        onConnect={() => {
          return connectHandler(c.type);
        }}
        onDisconnect={() => {
          return disconnectHandler(c.type);
        }}
        onReviewScopes={() => {
          return setScopeReviewType(c.type);
        }}
      />
    );
  };

  const grouped = showConnectorCategories
    ? groupConnectorsByCategory(filtered.map(getEffective))
    : [];

  const builtinList = renderBuiltinList({
    loadingState: allTypesLoadable.state,
    showConnectorCategories,
    grouped,
    filtered,
    renderCard,
    search,
  });
  return (
    <div
      ref={scrollContainerRef}
      className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]"
    >
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="flex w-full max-w-[900px] flex-wrap items-end justify-between gap-4">
            <div className="min-w-0 hidden md:block">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                Connectors
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Connect third-party services for your agents to use.
              </p>
            </div>
            <div className="relative w-full md:w-56">
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
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 pt-3 pb-16">
        <div className="relative mx-auto w-full max-w-[900px]">
          {activeTab === "builtin" &&
            allTypesLoadable.state === "hasData" &&
            showConnectorCategories && (
              <ConnectorCategoryMenu
                activeCategoryId={activeCategoryId}
                groups={grouped}
              />
            )}

          <div className="min-w-0 flex w-full max-w-[900px] flex-col gap-6">
            <div className="flex items-center justify-between">
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
              {activeTab === "custom" && isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
                  onClick={openCreateCustom}
                >
                  <IconPlus size={14} stroke={2} />
                  New connector
                </Button>
              )}
            </div>

            {activeTab === "builtin" && builtinList}

            {activeTab === "custom" && <CustomConnectorsPanel />}
          </div>
        </div>
      </main>

      {selectedType && (
        <ConnectModal
          onClose={() => {
            return setSelected(null);
          }}
          showPermissionDialogOnConnect
          onSuccess={() => {
            const label =
              allConnectors.find((c) => {
                return c.type === selectedType;
              })?.label ?? selectedType;
            toast.success(`${label} connected`);
          }}
        />
      )}

      {scopeReviewType && (
        <ScopeReviewModal
          connectorType={scopeReviewType}
          onClose={() => {
            return setScopeReviewType(null);
          }}
          onReconnect={(type) => {
            setScopeReviewType(null);
            detach(
              connect(type, { showPermissionDialog: true }, signal),
              Reason.DomCallback,
            );
          }}
        />
      )}

      {permissionDialogType && (
        <ConnectorPermissionDialog
          connectorType={permissionDialogType}
          onClose={() => {
            setPermissionDialogType(null);
          }}
        />
      )}
    </div>
  );
}
