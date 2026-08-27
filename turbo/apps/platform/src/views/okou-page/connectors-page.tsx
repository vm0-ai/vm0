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
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Filter,
  Layers3,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAccountSummary } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  PublicConnectorCatalogCategoryMetadata,
  PublicConnectorCatalogDiscoveryResponse,
  PublicConnectorCatalogStatusResponse,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Tabs, TabsList, TabsTrigger } from "@okouai/ui/components/ui/tabs";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import {
  connectorsPageTab$,
  setConnectorsPageTab$,
  openCustomConnectorCreateDialog$,
} from "../../signals/okou-page/settings/custom-connectors.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { agents$ } from "../../signals/agent.ts";
import { CustomConnectorsPanel } from "./components/settings/custom-connectors-panel.tsx";
import {
  connectorCatalogDiscovery$,
  connectConnectorOAuthAuthCode$,
  connectConnectorNoAuth$,
  connectFlowConnectorSlug$,
  connectorsSearch$,
  connectorsConnectionFilter$,
  disconnectConnector$,
  filteredConnectorCatalogItems$,
  loadMoreConnectorCatalog$,
  connectorsCategory$,
  connectorsSort$,
  setConnectorsCategory$,
  setConnectorsConnectionFilter$,
  setConnectorsSearch$,
  setConnectorsSort$,
  selectedConnectorSlug$,
  setSelectedConnectorSlug$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
  justConnectedSlugs$,
  relatedCatalogItems$,
  scopeReviewConnectorSlug$,
  setScopeReviewConnectorSlug$,
  getAvailableStatusAuthCodeAuthMethod,
  getConnectorStatusAuthMethod,
  type ConnectorCatalogSort,
  type ConnectorsConnectionFilter,
} from "../../signals/okou-page/settings/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  ConnectorCard,
  connectorAccountSummaryStatus,
  type ConnectorAccountSummaryStatus,
} from "./components/settings/connector-card.tsx";
import {
  launchConnectorConnect,
  type ConnectorConnectHandlers,
} from "./components/settings/launch-connector-connect.ts";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { ConnectorAccessManagementDialog } from "./components/settings/connector-access-management-dialog.tsx";
import { ConnectorAgentAccessButton } from "./components/settings/connector-agent-access-button.tsx";
import {
  closeConnectorAccessManagement$,
  connectorAuthorizedAgentsBySlug$,
  managedConnectorAccessSlug$,
  setManagedConnectorAccessSlug$,
} from "../../signals/okou-page/settings/connector-access-management.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { noConnectorImg } from "./platform-assets.ts";
import { AvatarFromUrl } from "./sidebar-shared.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
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

function connectorCategoryTranslation(
  id: string,
): { readonly label: string; readonly menuLabel: string } | null {
  switch (id) {
    case "ai": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.ai.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.ai.menu;
        }),
      };
    }
    case "ai-agent-apps": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiAgentApps.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiAgentApps.menu;
        }),
      };
    }
    case "ai-general-models": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiGeneralModels.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiGeneralModels.menu;
        }),
      };
    }
    case "ai-image-video": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiImageVideo.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiImageVideo.menu;
        }),
      };
    }
    case "ai-memory-tracing-eval": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiMemoryTracingEval.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiMemoryTracingEval.menu;
        }),
      };
    }
    case "ai-voice-audio": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.aiVoiceAudio.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.aiVoiceAudio.menu;
        }),
      };
    }
    case "communication-collaboration": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.communicationCollaboration
            .label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.communicationCollaboration
            .menu;
        }),
      };
    }
    case "data-automation-infrastructure": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.dataAutomationInfrastructure
            .label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.dataAutomationInfrastructure
            .menu;
        }),
      };
    }
    case "docs-files-knowledge": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.docsFilesKnowledge.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.docsFilesKnowledge.menu;
        }),
      };
    }
    case "engineering-team-execution": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.engineeringTeamExecution.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.engineeringTeamExecution.menu;
        }),
      };
    }
    case "marketing-content-growth": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.marketingContentGrowth.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.marketingContentGrowth.menu;
        }),
      };
    }
    case "meetings-scheduling": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.meetingsScheduling.label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.meetingsScheduling.menu;
        }),
      };
    }
    case "sales-crm-business-operations": {
      return {
        label: i18n.t(($) => {
          return $.connectors.catalog.categories.salesCrmBusinessOperations
            .label;
        }),
        menuLabel: i18n.t(($) => {
          return $.connectors.catalog.categories.salesCrmBusinessOperations
            .menu;
        }),
      };
    }
    default: {
      return null;
    }
  }
}

function localizeConnectorCategoryMetadata(
  metadata: PublicConnectorCatalogCategoryMetadata | undefined,
): PublicConnectorCatalogCategoryMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const categoryIds = new Set<string>();
  return {
    categories: metadata.categories.flatMap((category) => {
      if (categoryIds.has(category.id)) {
        return [];
      }
      categoryIds.add(category.id);
      return [{ ...category, ...connectorCategoryTranslation(category.id) }];
    }),
    groups: metadata.groups.map((group) => {
      return { ...group, ...connectorCategoryTranslation(group.id) };
    }),
  };
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
          className="zero-btn-morandi h-10 shrink-0 gap-1.5 rounded-lg border"
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

function ConnectorSortDropdown({
  value,
  onChange,
}: {
  readonly value: ConnectorCatalogSort;
  readonly onChange: (value: ConnectorCatalogSort) => void;
}) {
  const { t } = useTranslation();
  const label =
    value === "alphabetical"
      ? t(($) => {
          return $.connectors.catalog.sort.alphabetical;
        })
      : t(($) => {
          return $.connectors.catalog.sort.recommended;
        });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t(($) => {
            return $.connectors.catalog.sort.aria;
          })}
          className="zero-btn-morandi h-10 shrink-0 gap-1.5 rounded-lg border"
        >
          <ArrowUpDown size={14} />
          <span>{label}</span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <ConnectorFilterOption
          active={value === "recommended"}
          onSelect={() => {
            onChange("recommended");
          }}
        >
          {t(($) => {
            return $.connectors.catalog.sort.recommended;
          })}
        </ConnectorFilterOption>
        <ConnectorFilterOption
          active={value === "alphabetical"}
          onSelect={() => {
            onChange("alphabetical");
          }}
        >
          {t(($) => {
            return $.connectors.catalog.sort.alphabetical;
          })}
        </ConnectorFilterOption>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConnectorDirectoryToolbar({
  search,
  setSearch,
  connectionFilter,
  agents,
  setConnectionFilter,
  sort,
  setSort,
}: {
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly agents: readonly AgentResponse[];
  readonly setConnectionFilter: (value: ConnectorsConnectionFilter) => void;
  readonly sort: ConnectorCatalogSort;
  readonly setSort: (value: ConnectorCatalogSort) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <div className="relative min-w-0 flex-1">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <Input
          type="text"
          aria-label={t(($) => {
            return $.connectors.catalog.search;
          })}
          placeholder={t(($) => {
            return $.connectors.catalog.search;
          })}
          value={search}
          onChange={(event) => {
            return setSearch(event.target.value);
          }}
          className="h-10 rounded-lg pl-9 pr-3"
        />
      </div>
      <div className="flex items-center gap-2">
        <ConnectorFilterDropdown
          value={connectionFilter}
          agents={agents}
          onChange={setConnectionFilter}
        />
        <ConnectorSortDropdown value={sort} onChange={setSort} />
      </div>
    </div>
  );
}

function CustomConnectorAction({
  isAdmin,
  onCreate,
}: {
  readonly isAdmin: boolean;
  readonly onCreate: () => void;
}) {
  const { t } = useTranslation();
  if (!isAdmin) {
    return null;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border"
      onClick={onCreate}
    >
      <Plus size={14} />
      {t(($) => {
        return $.connectors.catalog.newConnector;
      })}
    </Button>
  );
}

function categoryCountTotal(
  categoryCounts: Readonly<Record<string, number>>,
): number {
  return Object.values(categoryCounts).reduce((total, count) => {
    return total + count;
  }, 0);
}

function ConnectorCategoryButton({
  categoryId,
  label,
  count,
  selected,
  nested = false,
  onSelect,
}: {
  readonly categoryId: string | null;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly nested?: boolean;
  readonly onSelect: (categoryId: string | null) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={
        categoryId
          ? `connector-category-${categoryId}`
          : "connector-category-all"
      }
      className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 ${
        nested ? "pl-5" : ""
      } ${
        selected
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground"
      }`}
      onClick={() => {
        onSelect(categoryId);
      }}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span
        className={`shrink-0 text-xs tabular-nums ${
          selected ? "text-background/70" : "text-muted-foreground/70"
        }`}
      >
        {formatLocalizedNumber(count)}
      </span>
    </button>
  );
}

function ConnectorCategoryRail({
  metadata,
  categoryCounts,
  selectedCategory,
  onSelect,
}: {
  readonly metadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly selectedCategory: string | null;
  readonly onSelect: (categoryId: string | null) => void;
}) {
  const { t } = useTranslation();
  if (!metadata) {
    return null;
  }
  const groupedCategoryIds = new Set<string>();
  return (
    <aside className="sticky top-4 hidden max-h-[calc(100vh-2rem)] w-52 shrink-0 self-start overflow-y-auto pr-4 lg:block">
      <div className="mb-2 flex items-center gap-2 px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Layers3 size={13} />
        {t(($) => {
          return $.connectors.catalog.category;
        })}
      </div>
      <nav
        aria-label={t(($) => {
          return $.connectors.catalog.categoriesAria;
        })}
        className="flex flex-col gap-0.5"
      >
        <ConnectorCategoryButton
          categoryId={null}
          label={t(($) => {
            return $.connectors.catalog.allCategories;
          })}
          count={categoryCountTotal(categoryCounts)}
          selected={selectedCategory === null}
          onSelect={onSelect}
        />
        {metadata.groups.map((group) => {
          const categories = metadata.categories.filter((category) => {
            return (
              category.groupId === group.id &&
              ((categoryCounts[category.id] ?? 0) > 0 ||
                selectedCategory === category.id)
            );
          });
          for (const category of categories) {
            groupedCategoryIds.add(category.id);
          }
          if (categories.length === 0) {
            return null;
          }
          const groupCount = categories.reduce((total, category) => {
            return total + (categoryCounts[category.id] ?? 0);
          }, 0);
          return (
            <div key={group.id} className="mt-2">
              <div
                data-testid={`connector-category-group-${group.id}`}
                className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs font-medium text-muted-foreground"
              >
                <span>{group.menuLabel}</span>
                <span className="tabular-nums text-muted-foreground/60">
                  {formatLocalizedNumber(groupCount)}
                </span>
              </div>
              {categories.map((category) => {
                return (
                  <ConnectorCategoryButton
                    key={category.id}
                    categoryId={category.id}
                    label={category.menuLabel}
                    count={categoryCounts[category.id] ?? 0}
                    selected={selectedCategory === category.id}
                    nested
                    onSelect={onSelect}
                  />
                );
              })}
            </div>
          );
        })}
        <div className="mt-2 flex flex-col gap-0.5">
          {metadata.categories.flatMap((category) => {
            const count = categoryCounts[category.id] ?? 0;
            if (
              groupedCategoryIds.has(category.id) ||
              (count === 0 && selectedCategory !== category.id)
            ) {
              return [];
            }
            return [
              <ConnectorCategoryButton
                key={category.id}
                categoryId={category.id}
                label={category.menuLabel}
                count={count}
                selected={selectedCategory === category.id}
                onSelect={onSelect}
              />,
            ];
          })}
        </div>
      </nav>
    </aside>
  );
}

function ConnectorCategoryDropdown({
  metadata,
  categoryCounts,
  selectedCategory,
  onSelect,
}: {
  readonly metadata: PublicConnectorCatalogCategoryMetadata | undefined;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly selectedCategory: string | null;
  readonly onSelect: (categoryId: string | null) => void;
}) {
  const { t } = useTranslation();
  if (!metadata) {
    return null;
  }
  const selectedLabel = selectedCategory
    ? (metadata.categories.find((category) => {
        return category.id === selectedCategory;
      })?.menuLabel ??
      t(($) => {
        return $.connectors.catalog.allCategories;
      }))
    : t(($) => {
        return $.connectors.catalog.allCategories;
      });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="zero-btn-morandi h-9 w-full justify-between rounded-lg border lg:hidden"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Layers3 size={14} />
            <span className="truncate">{selectedLabel}</span>
          </span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(420px,var(--available-height))] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        <ConnectorFilterOption
          active={selectedCategory === null}
          onSelect={() => {
            onSelect(null);
          }}
        >
          <span className="flex-1">
            {t(($) => {
              return $.connectors.catalog.allCategories;
            })}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatLocalizedNumber(categoryCountTotal(categoryCounts))}
          </span>
        </ConnectorFilterOption>
        {metadata.categories.flatMap((category) => {
          const count = categoryCounts[category.id] ?? 0;
          if (count === 0 && selectedCategory !== category.id) {
            return [];
          }
          return [
            <ConnectorFilterOption
              key={category.id}
              active={selectedCategory === category.id}
              onSelect={() => {
                onSelect(category.id);
              }}
            >
              <span className="flex-1 truncate">{category.menuLabel}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatLocalizedNumber(count)}
              </span>
            </ConnectorFilterOption>,
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
  return (
    <ConnectorAgentAccessButton
      agents={agents}
      loading={loading}
      connectorLabel={connectorLabel}
      onClick={onClick}
    />
  );
}

function renderBuiltinList({
  loadingState,
  connectors,
  renderCard,
  search,
  connectionFilter,
}: {
  loadingState: "loading" | "hasData" | "hasError";
  connectors: readonly PlatformConnectorCatalogStatusItem[];
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

  if (connectors.length === 0) {
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

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {connectors.map(renderCard)}
    </div>
  );
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
  catalogStatusLoadable: Loadable<
    | PublicConnectorCatalogDiscoveryResponse
    | PublicConnectorCatalogStatusResponse
  >,
): number | null {
  if (catalogStatusLoadable.state !== "hasData") {
    return null;
  }
  if ("totalConnectorCount" in catalogStatusLoadable.data) {
    return catalogStatusLoadable.data.totalConnectorCount;
  }
  return catalogStatusLoadable.data.connectors.length;
}

function effectiveMatchingConnectorCount(
  catalogStatusLoadable: Loadable<
    | PublicConnectorCatalogDiscoveryResponse
    | PublicConnectorCatalogStatusResponse
  >,
): number | null {
  if (catalogStatusLoadable.state !== "hasData") {
    return null;
  }
  if (
    "totalConnectorCount" in catalogStatusLoadable.data &&
    catalogStatusLoadable.data.matchingConnectorCount !== undefined
  ) {
    return catalogStatusLoadable.data.matchingConnectorCount;
  }
  return null;
}

function effectiveConnectorCategoryCounts(
  catalogStatusLoadable: Loadable<
    | PublicConnectorCatalogDiscoveryResponse
    | PublicConnectorCatalogStatusResponse
  >,
): Record<string, number> {
  if (catalogStatusLoadable.state !== "hasData") {
    return {};
  }
  if (
    "totalConnectorCount" in catalogStatusLoadable.data &&
    catalogStatusLoadable.data.categoryConnectorCounts
  ) {
    return catalogStatusLoadable.data.categoryConnectorCounts;
  }
  const counts: Record<string, number> = {};
  for (const connector of catalogStatusLoadable.data.connectors) {
    counts[connector.category] = (counts[connector.category] ?? 0) + 1;
  }
  return counts;
}

function loadedConnectorItems(
  loadable: Loadable<PlatformConnectorCatalogStatusItem[]>,
): readonly PlatformConnectorCatalogStatusItem[] {
  return loadable.state === "hasData" ? loadable.data : [];
}

function localizedCategoryMetadata(
  loadable: Loadable<
    | PublicConnectorCatalogDiscoveryResponse
    | PublicConnectorCatalogStatusResponse
  >,
): PublicConnectorCatalogCategoryMetadata | undefined {
  return localizeConnectorCategoryMetadata(
    loadable.state === "hasData" ? loadable.data.categoryMetadata : undefined,
  );
}

function selectedConnectorFromItems(
  connectors: readonly PlatformConnectorCatalogStatusItem[],
  connectorSlug: ConnectorSlug | null,
): PlatformConnectorCatalogStatusItem | undefined {
  if (!connectorSlug) {
    return undefined;
  }
  return connectors.find((connector) => {
    return connector.slug === connectorSlug;
  });
}

function connectorCatalogHasMore(
  loadable: Loadable<
    | PublicConnectorCatalogDiscoveryResponse
    | PublicConnectorCatalogStatusResponse
  >,
): boolean {
  return (
    loadable.state === "hasData" &&
    "totalConnectorCount" in loadable.data &&
    Boolean(loadable.data.nextCursor)
  );
}

function connectorDirectoryResultSummary(args: {
  readonly connectionFilter: ConnectorsConnectionFilter;
  readonly matchingConnectorCount: number | null;
  readonly shownConnectorCount: number;
}): string {
  const shown = formatLocalizedNumber(args.shownConnectorCount);
  if (
    args.connectionFilter.kind === "agent" ||
    args.matchingConnectorCount === null
  ) {
    return i18n.t(
      ($) => {
        return $.connectors.catalog.resultsLoaded;
      },
      { shown },
    );
  }
  return i18n.t(
    ($) => {
      return $.connectors.catalog.results;
    },
    {
      shown,
      total: formatLocalizedNumber(args.matchingConnectorCount),
    },
  );
}

interface SettingsConnectorCardProps {
  readonly connector: PlatformConnectorCatalogStatusItem;
  readonly accountManagement: boolean;
  readonly accountSummary: ConnectorAccountSummary | undefined;
  readonly accountSummaryStatus: ConnectorAccountSummaryStatus;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly disconnecting: boolean;
  readonly connect: ConnectorConnectHandlers;
  readonly onManageAccounts: () => void;
  readonly onManageAccess: () => void;
  readonly onDisconnect: () => void;
  readonly onReviewScopes: () => void;
}

interface ConnectorCatalogHeaderProps {
  readonly connectorCatalogCountEnabled: boolean;
  readonly connectorCatalogCount: number | null;
}

function ConnectorCatalogHeader(props: ConnectorCatalogHeaderProps) {
  const { t } = useTranslation();
  const description =
    props.connectorCatalogCountEnabled && props.connectorCatalogCount !== null
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
      <div className="mx-auto w-full max-w-[1180px]">
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
      onClick={props.onManageAccess}
    />
  );
  if (props.accountManagement) {
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
  if (!props.connected) {
    return (
      <ConnectorCard
        variant="catalog"
        connector={props.connector}
        busy={props.busy}
        connect={props.connect}
      />
    );
  }
  return (
    <ConnectorCard
      variant="connection"
      connector={props.connector}
      connected
      busy={props.busy}
      disconnecting={props.disconnecting}
      connect={props.connect}
      onDisconnect={props.onDisconnect}
      manageAccess={manageAccess}
      onReviewScopes={props.onReviewScopes}
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
  const connectorCatalogCountEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorCatalogCount] ?? false;
  const connectorAccountsEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorAccounts] ?? false;
  const accountSummariesLoadable = useLoadable(
    connectorAccountSummaryByTarget$,
  );
  const accountSummaryStatus = connectorAccountSummaryStatus(
    accountSummariesLoadable.state,
  );
  const finishAccountConnection = useSet(finishConnectorAccountConnection$);
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

  const search = useGet(connectorsSearch$);
  const setSearch = useSet(setConnectorsSearch$);
  const connectionFilter = useGet(connectorsConnectionFilter$);
  const setConnectionFilter = useSet(setConnectorsConnectionFilter$);
  const selectedCategory = useGet(connectorsCategory$);
  const setCategory = useSet(setConnectorsCategory$);
  const sort = useGet(connectorsSort$);
  const setSort = useSet(setConnectorsSort$);
  const [loadMoreLoadable, loadMore] = useLoadableSet(
    loadMoreConnectorCatalog$,
  );
  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const filteredConnectors = loadedConnectorItems(filteredCatalogItemsLoadable);
  const connectorCatalogCount = effectiveConnectorCatalogCount(
    catalogStatusLoadable,
  );
  const matchingConnectorCount = effectiveMatchingConnectorCount(
    catalogStatusLoadable,
  );
  const categoryCounts = effectiveConnectorCategoryCounts(
    catalogStatusLoadable,
  );
  const categoryMetadata = localizedCategoryMetadata(catalogStatusLoadable);
  const allConnectors = loadedConnectorItems(relatedCatalogItemsLoadable);
  const selectedConnector = selectedConnectorFromItems(
    allConnectors,
    selectedConnectorSlug,
  );
  const managedConnectorLabel = connectorLabelForSlug(
    allConnectors,
    managedConnectorSlug,
  );
  const disconnecting = disconnectLoadable.state === "loading";
  const hasMore = connectorCatalogHasMore(catalogStatusLoadable);

  const connectHandlers = (
    connector: PlatformConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    return {
      openModal: () => {
        setSelected(connector.slug);
      },
      connectBrowserAuth: (authMethod) => {
        return connect(
          connector.slug,
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
            connectorSlug: connector.slug,
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

  const finishExplicitAccountAdd = async (
    connector: PlatformConnectorCatalogStatusItem,
    connectionId: string | null,
  ): Promise<void> => {
    await finishAccountConnection(
      {
        target: { kind: "builtin", connectorSlug: connector.slug },
        connectionId,
        connectorLabel: connector.label,
        mode: { kind: "add" },
      },
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

  const disconnectHandler = async (
    connectorSlug: ConnectorSlug,
    connectorLabel: string,
  ) => {
    if (disconnecting) {
      return;
    }
    await disconnect(connectorSlug, connectorLabel, signal);
  };

  const renderCard = (c: PlatformConnectorCatalogStatusItem) => {
    const isConnected = c.connected || optimisticConnected.has(c.slug);
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
        accountManagement={connectorAccountsEnabled}
        accountSummary={summary}
        accountSummaryStatus={accountSummaryStatus}
        connected={isConnected}
        busy={isPolling}
        disconnecting={disconnecting}
        connect={
          connectorAccountsEnabled
            ? accountConnectHandlers(c)
            : connectHandlers(c)
        }
        onDisconnect={() => {
          detach(disconnectHandler(c.slug, c.label), Reason.DomCallback);
        }}
        onManageAccounts={() => {
          return openAccountManager(c, signal);
        }}
        onManageAccess={() => {
          return setManagedConnectorSlug(c.slug);
        }}
        onReviewScopes={() => {
          return setScopeReviewConnectorSlug(c.slug);
        }}
      />
    );
  };

  const builtinList = renderBuiltinList({
    loadingState: filteredCatalogItemsLoadable.state,
    connectors: filteredConnectors,
    renderCard,
    search,
    connectionFilter,
  });
  const resultSummary = connectorDirectoryResultSummary({
    connectionFilter,
    matchingConnectorCount,
    shownConnectorCount: filteredConnectors.length,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <ConnectorCatalogHeader
        connectorCatalogCountEnabled={connectorCatalogCountEnabled}
        connectorCatalogCount={connectorCatalogCount}
      />

      <main className="flex-1 px-4 pb-16 pt-3 sm:px-6">
        <div className="relative mx-auto w-full max-w-[1180px]">
          <div className="flex min-w-0 w-full flex-col gap-5">
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
              {activeTab === "custom" && (
                <CustomConnectorAction
                  isAdmin={isAdmin}
                  onCreate={openCreateCustom}
                />
              )}
            </div>

            {activeTab === "builtin" && (
              <>
                <ConnectorDirectoryToolbar
                  search={search}
                  setSearch={setSearch}
                  connectionFilter={connectionFilter}
                  agents={agents}
                  setConnectionFilter={setConnectionFilter}
                  sort={sort}
                  setSort={setSort}
                />
                <div className="flex items-start gap-6">
                  <ConnectorCategoryRail
                    metadata={categoryMetadata}
                    categoryCounts={categoryCounts}
                    selectedCategory={selectedCategory}
                    onSelect={setCategory}
                  />
                  <section className="flex min-w-0 flex-1 flex-col gap-4">
                    <ConnectorCategoryDropdown
                      metadata={categoryMetadata}
                      categoryCounts={categoryCounts}
                      selectedCategory={selectedCategory}
                      onSelect={setCategory}
                    />
                    {filteredCatalogItemsLoadable.state === "hasData" && (
                      <p
                        className="text-sm text-muted-foreground"
                        data-testid="connector-result-count"
                      >
                        {resultSummary}
                      </p>
                    )}
                    {builtinList}
                    {hasMore && (
                      <div className="flex justify-center pt-3">
                        <Button
                          variant="outline"
                          className="zero-btn-morandi min-w-36 rounded-lg border"
                          disabled={loadMoreLoadable.state === "loading"}
                          onClick={() => {
                            detach(
                              loadMore(signal),
                              Reason.DomCallback,
                              "connector catalog paging",
                            );
                          }}
                        >
                          {loadMoreLoadable.state === "loading" && (
                            <Loader2 size={15} className="animate-spin" />
                          )}
                          {loadMoreLoadable.state === "loading"
                            ? t(($) => {
                                return $.connectors.accounts.loadingMore;
                              })
                            : t(($) => {
                                return $.connectors.accounts.loadMore;
                              })}
                        </Button>
                      </div>
                    )}
                  </section>
                </div>
              </>
            )}

            {activeTab === "custom" && <CustomConnectorsPanel />}
          </div>
        </div>
      </main>

      {selectedConnector && (
        <ConnectModal
          item={selectedConnector}
          authorizeVisibleAgentsOnConnect
          onClose={() => {
            return setSelected(null);
          }}
          onSuccess={() => {
            const label =
              allConnectors.find((c) => {
                return c.slug === selectedConnectorSlug;
              })?.label ?? selectedConnectorSlug;
            toast.success(
              t(
                ($) => {
                  return $.connectors.callback.connected;
                },
                { connector: label },
              ),
            );
          }}
        />
      )}

      {accountConnect && (
        <ConnectModal
          item={accountConnect.connector}
          accountMode={accountConnect.mode}
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
              account,
            });
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
              return connector.slug === connectorSlug;
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
      <ConnectorAccountNameDialog />

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
