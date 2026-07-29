// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconFileText,
  IconUserCircle,
  IconShield,
  IconUsers,
  IconSearch,
  IconX,
  IconMessageCircle,
  IconWand,
} from "@tabler/icons-react";
import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Card,
  CardContent,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { ZeroInstructionsTab } from "../zero-page/zero-instructions-tab.tsx";
import { ZeroSettingsTab } from "../zero-page/zero-settings-tab.tsx";

import { TONE_OPTIONS, type Tone } from "../zero-page/zero-tone-constants.ts";
import {
  agentDetail$,
  agentInstructions$,
  agentEditedContent$,
  agentInstructionsDirty$,
  setAgentEditedContent$,
  discardAgentEdit$,
  buildAgentInstructions$,
  updateAgentSettings$,
  deleteAgent$,
  agentAuthorizedConnectors$,
  authorizeAgentConnector$,
  deauthorizeAgentConnector$,
  saveAgentConnectors$,
  agentActiveTab$,
  setAgentActiveTab$,
} from "../../signals/zero-page/zero-job-detail.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import { Link } from "../router/link.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
import { AgentAvatarImg } from "../zero-page/zero-sidebar-shared.tsx";
import { openAvatarMaker$ } from "../../signals/zero-page/settings/avatar-maker.ts";
import {
  agents$,
  currentAgent$,
  currentAgentId$,
} from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { user$ } from "../../signals/auth.ts";
import { ZeroNoPermissionIllustration } from "../zero-page/components/zero-no-permission-illustration.tsx";
import { ConnectorCard } from "../zero-page/components/settings/connector-card.tsx";
import { PermissionsDrawer } from "../zero-page/components/settings/permissions-dialog.tsx";
import type { PermissionDraftIntent } from "../../signals/zero-page/settings/permission-draft-intent.ts";
import { savePermissionDraftPolicies } from "../../signals/zero-page/settings/permission-grant-save.ts";
import { noConnectorImg } from "../zero-page/platform-assets.ts";
import { JobCustomConnectorsSection } from "./job-custom-connectors-section.tsx";
import {
  applyUserPermissionGrants$,
  currentAgentUserPermissionGrants$,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  allConnectorCatalogItems$,
  matchesConnectorSearch,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  currentAgentVisibleWorkflows$,
  copyWorkflow$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  permConnectorRef$,
  agentPermissionMetadata$,
  setPermConnectorRef$,
  permSearch$,
  setPermSearch$,
  permSearchActive$,
  setPermSearchActive$,
  permSavingRef$,
  setPermSavingRef$,
} from "../../signals/zero-page/zero-job-detail-page.ts";
import type { FirewallPolicies } from "@vm0/connectors/firewall-types";
import type {
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { activeUserPermissionGrantSnapshot } from "../../signals/user-permission-grants.ts";
import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
// ---------------------------------------------------------------------------
// Page shell: skeleton, error, header
// ---------------------------------------------------------------------------

function loadableErrorMessage(
  loadable: {
    state: string;
    error?: unknown;
  },
  unknownErrorMessage: string,
): string | null {
  if (loadable.state !== "hasError") {
    return null;
  }
  return loadable.error instanceof Error
    ? loadable.error.message
    : unknownErrorMessage;
}

function Breadcrumb({
  currentName,
  className,
}: {
  currentName?: string;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  return (
    <DetailPageBreadcrumbBar className={className}>
      <Link
        pathname="/agents"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconUsers size={14} stroke={1.5} className="shrink-0" />
        {t(($) => {
          return $.list.title;
        })}
      </Link>
      <span className="text-muted-foreground/40 select-none">/</span>
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
        {currentName ??
          t(($) => {
            return $.fallbackName;
          })}
      </span>
    </DetailPageBreadcrumbBar>
  );
}

function DetailSkeleton() {
  return (
    <DetailPageShell scroll={false}>
      <Breadcrumb />
      <DetailPageHeader className="pb-3">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="h-9 w-80 rounded bg-muted mt-4" />
        </div>
      </DetailPageHeader>
    </DetailPageShell>
  );
}

function isNotFoundError(error: string): boolean {
  return /not found|404|no(t| )exist/i.test(error);
}

function DetailError({ error, agentId }: { error: string; agentId: string }) {
  const { t } = useTranslation("agents");
  if (isNotFoundError(error)) {
    return (
      <DetailPageShell scroll={false}>
        <Breadcrumb />
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 pb-16">
          <div className="flex flex-col items-center text-center gap-4 max-w-sm">
            <ZeroNoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                {t(($) => {
                  return $.detail.notFound.title;
                })}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t(
                  ($) => {
                    return $.detail.notFound.description;
                  },
                  { agentId },
                )}
              </p>
            </div>
            <Link
              pathname="/agents"
              className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
            >
              {t(($) => {
                return $.detail.notFound.back;
              })}
            </Link>
          </div>
        </main>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell scroll={false}>
      <Breadcrumb />
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <Link
                pathname="/agents/:agentId"
                options={{ pathParams: { agentId: agentId } }}
                className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
              >
                {t(($) => {
                  return $.actions.retry;
                })}
              </Link>
            </CardContent>
          </Card>
        </div>
      </main>
    </DetailPageShell>
  );
}

const TAB_TRIGGER_CLASS =
  "gap-1.5 text-sm data-[state=active]:bg-background px-3";

function resolveVisibleTab(
  rawTab: string,
  hideProfileAndInstructions: boolean,
): string {
  if (hideProfileAndInstructions && rawTab !== "authorization") {
    return "authorization";
  }
  return rawTab;
}

function AgentTabNav({
  activeTab,
  onTabChange,
  showProfileAndInstructions,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  showProfileAndInstructions: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex-1 min-w-0"
    >
      {/* Mobile: Select dropdown */}
      <div className="sm:hidden">
        <Select value={activeTab} onValueChange={onTabChange}>
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="authorization">
              {t(($) => {
                return $.detail.tabs.authorization;
              })}
            </SelectItem>
            {showProfileAndInstructions && (
              <SelectItem value="profile">
                {t(($) => {
                  return $.detail.tabs.profile;
                })}
              </SelectItem>
            )}
            {showProfileAndInstructions && (
              <SelectItem value="instructions">
                {t(($) => {
                  return $.detail.tabs.instructions;
                })}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      {/* Desktop: tab list */}
      <TabsList className="zero-tabs hidden sm:inline-flex h-9 gap-1 px-1 py-1">
        <TabsTrigger value="authorization" className={TAB_TRIGGER_CLASS}>
          <IconShield size={14} stroke={1.5} />
          {t(($) => {
            return $.detail.tabs.authorization;
          })}
        </TabsTrigger>
        {showProfileAndInstructions && (
          <TabsTrigger value="profile" className={TAB_TRIGGER_CLASS}>
            <IconUserCircle size={14} stroke={1.5} />
            {t(($) => {
              return $.detail.tabs.profile;
            })}
          </TabsTrigger>
        )}
        {showProfileAndInstructions && (
          <TabsTrigger value="instructions" className={TAB_TRIGGER_CLASS}>
            <IconFileText size={14} stroke={1.5} />
            {t(($) => {
              return $.detail.tabs.instructions;
            })}
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}

function resolveSound(sound: string): Tone {
  return (TONE_OPTIONS as readonly string[]).includes(sound)
    ? (sound as Tone)
    : "professional";
}

function PermissionListSkeleton() {
  return (
    <div className="mx-auto max-w-[900px]">
      <div className="zero-card animate-pulse">
        {Array.from({ length: 4 }, (_, i) => {
          return (
            <div
              key={i}
              className={cn(
                "flex items-center gap-3 px-5 py-4",
                i < 3 && "border-b border-border/50",
              )}
            >
              <span className="h-5 w-5 shrink-0 rounded bg-muted/50" />
              <div className="flex-1 space-y-1.5">
                <span className="block h-4 w-24 rounded bg-muted/50" />
                <span className="block h-3 w-48 rounded bg-muted/30" />
              </div>
              <span className="h-4 w-7 rounded-full bg-muted/50" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermissionGrantsError() {
  const { t } = useTranslation("agents");
  return (
    <div className="mx-auto max-w-[900px]">
      <div className="zero-card px-5 py-4 text-sm text-destructive">
        {t(($) => {
          return $.authorization.permissionLoadError;
        })}
      </div>
    </div>
  );
}

function NoConnectedConnectors() {
  const { t } = useTranslation("agents");
  return (
    <>
      <div className="zero-card py-8 flex flex-col items-center gap-3">
        <img
          src={noConnectorImg}
          alt={t(($) => {
            return $.authorization.noConnectorsAlt;
          })}
          className="h-20 w-20 object-contain opacity-80"
        />
        <p className="text-sm text-muted-foreground text-center">
          {t(($) => {
            return $.authorization.noConnectorsBeforeLink;
          })}{" "}
          <Link
            pathname="/connectors"
            className="font-medium text-foreground hover:underline"
          >
            {t(($) => {
              return $.authorization.connectorsLink;
            })}
          </Link>{" "}
          {t(($) => {
            return $.authorization.noConnectorsAfterLink;
          })}
        </p>
      </div>
      <JobCustomConnectorsSection />
    </>
  );
}

function ConnectedConnectorPermissions({
  filteredConnectors,
  authorizedSet,
  search,
  setSearch,
  searchActive,
  setSearchActive,
  savingConnectorRef,
  canManagePermissions,
  onToggle,
  onManage,
}: {
  filteredConnectors: readonly PublicConnectorCatalogStatusItem[];
  authorizedSet: ReadonlySet<string>;
  search: string;
  setSearch: (value: string) => void;
  searchActive: boolean;
  setSearchActive: (active: boolean) => void;
  savingConnectorRef: ConnectorRef | null;
  canManagePermissions: boolean;
  onToggle: (connectorRef: ConnectorRef, checked: boolean) => Promise<void>;
  onManage: (connectorRef: ConnectorRef) => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <>
      <div className="zero-card">
        <div className="relative border-b border-border/50">
          <div
            className={cn(
              "px-5 pt-4 pb-3 pr-12 text-sm text-muted-foreground transition-opacity duration-150",
              searchActive && "opacity-0 select-none",
            )}
            aria-hidden={searchActive}
          >
            {t(($) => {
              return $.authorization.description;
            })}
          </div>
          {searchActive && (
            <div className="absolute inset-0 flex items-center gap-2 px-5">
              <IconSearch
                size={14}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
              <input
                ref={(el) => {
                  return el?.focus();
                }}
                type="text"
                placeholder={t(($) => {
                  return $.authorization.searchPlaceholder;
                })}
                value={search}
                onChange={(e) => {
                  return setSearch(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    setSearchActive(false);
                  }
                }}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setSearchActive(false);
                }}
                className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label={t(($) => {
                  return $.authorization.closeSearch;
                })}
              >
                <IconX size={14} stroke={1.5} />
              </button>
            </div>
          )}
          {!searchActive && (
            <button
              type="button"
              onClick={() => {
                return setSearchActive(true);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label={t(($) => {
                return $.authorization.findConnectors;
              })}
            >
              <IconSearch size={14} stroke={1.5} />
            </button>
          )}
        </div>
        {filteredConnectors.length > 0 ? (
          filteredConnectors.map((c, i) => {
            return (
              <ConnectorCard
                key={c.connectorRef}
                variant="permission"
                connector={c}
                enabled={authorizedSet.has(c.connectorRef)}
                onToggle={onDomEventFn(async (checked) => {
                  await onToggle(c.connectorRef, checked);
                })}
                loading={savingConnectorRef === c.connectorRef}
                showManage={
                  canManagePermissions && c.permissionSummary.hasPermissions
                }
                onManage={() => {
                  return onManage(c.connectorRef);
                }}
                isLast={i === filteredConnectors.length - 1}
              />
            );
          })
        ) : (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            {t(
              ($) => {
                return $.authorization.noResults;
              },
              { search },
            )}
          </p>
        )}
      </div>

      <JobCustomConnectorsSection />
    </>
  );
}

function AgentPermissionsDrawer({
  targetId,
  targetKind = "agent",
  connectorRef,
  connectorLabel,
  displayName,
  initialPolicies,
  initialGrants,
  initialIntent,
  initialSearch,
  initialContextKey,
  resetEnabled,
  readOnly,
  onApply,
  onClose,
}: {
  targetId: string;
  targetKind?: "agent" | "workflow";
  connectorRef: ConnectorRef | null;
  connectorLabel: string;
  displayName: string;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly UserPermissionGrantResponse[];
  initialIntent?: PermissionDraftIntent;
  initialSearch?: string;
  initialContextKey?: string;
  resetEnabled: boolean;
  readOnly: boolean;
  onApply: (
    intent: PermissionDraftIntent,
    options: {
      readonly metadata: PublicConnectorCatalogPermissionDetail;
    },
  ) => Promise<void>;
  onClose: () => void;
}) {
  if (!connectorRef) {
    return null;
  }
  return (
    <PermissionsDrawer
      agentId={targetId}
      targetKind={targetKind}
      connectorRef={connectorRef}
      connectorLabel={connectorLabel}
      metadata$={agentPermissionMetadata$}
      displayName={displayName}
      initialPolicies={initialPolicies}
      initialGrants={initialGrants}
      initialIntent={initialIntent}
      initialSearch={initialSearch}
      initialContextKey={initialContextKey}
      resetEnabled={resetEnabled}
      readOnly={readOnly}
      onApply={onApply}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Tab wrappers — resolve signals into shared component props
// ---------------------------------------------------------------------------

function JobPermissionsTab({
  agentId,
  displayName,
}: {
  agentId: string;
  displayName: string;
}) {
  const { t } = useTranslation("agents");
  // Use useLastLoadable so the list keeps showing the previous data while the
  // signal refetches after a toggle/save or a permission-policy reload. This
  // prevents the entire list from flickering to the skeleton on each change
  // (issue #9141).
  const connectorsLoadable = useLastLoadable(agentAuthorizedConnectors$);
  const authorizedConnectors =
    connectorsLoadable.state === "hasData" ? connectorsLoadable.data : [];
  const authorizeFn = useSet(authorizeAgentConnector$);
  const deauthorizeFn = useSet(deauthorizeAgentConnector$);
  const saveConnectors = useSet(saveAgentConnectors$);
  const pageSignal = useGet(pageSignal$);
  const userGrantsLoadable = useLoadable(currentAgentUserPermissionGrants$);
  const userGrants =
    userGrantsLoadable.state === "hasData" ? userGrantsLoadable.data : [];
  const activeUserGrantSnapshot = activeUserPermissionGrantSnapshot(userGrants);
  const userGrantPolicies =
    userGrantsLoadable.state === "hasData"
      ? activeUserGrantSnapshot.policies
      : null;
  const drawerInitialPolicies = userGrantPolicies ?? {};
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);
  const connectorRef = useGet(permConnectorRef$);
  const setConnectorRef = useSet(setPermConnectorRef$);
  const search = useGet(permSearch$);
  const setSearch = useSet(setPermSearch$);
  const searchActive = useGet(permSearchActive$);
  const setSearchActive = useSet(setPermSearchActive$);
  const savingRef = useGet(permSavingRef$);
  const setSavingRef = useSet(setPermSavingRef$);

  const connectorsLoading = connectorsLoadable.state === "loading";

  const catalogItemsLoadable = useLastLoadable(allConnectorCatalogItems$);
  const allConnectors =
    catalogItemsLoadable.state === "hasData" ? catalogItemsLoadable.data : [];
  const canManagePermissions = true;

  const connectedConnectors = allConnectors.filter((c) => {
    return c.connected;
  });
  const connectorLabel = connectorRef
    ? (allConnectors.find((connector) => {
        return connector.connectorRef === connectorRef;
      })?.label ?? connectorRef)
    : "";
  const filteredConnectors = connectedConnectors.filter((c) => {
    return matchesConnectorSearch(search, c);
  });
  const authorizedSet = new Set(authorizedConnectors);

  const handleToggle = async (
    targetConnectorRef: ConnectorRef,
    checked: boolean,
  ) => {
    if (savingRef !== null) {
      return;
    }
    const modify = checked
      ? authorizeFn(targetConnectorRef, pageSignal)
      : deauthorizeFn(targetConnectorRef, pageSignal);
    setSavingRef(targetConnectorRef);
    await bestEffort(
      (async () => {
        await modify;
        await saveConnectors(
          targetConnectorRef,
          checked ? "add" : "remove",
          pageSignal,
        );
        toast.success(
          t(($) => {
            return $.authorization.connectorsSaved;
          }),
        );
      })(),
    );
    setSavingRef(null);
  };

  if (
    catalogItemsLoadable.state !== "hasData" ||
    connectorsLoading ||
    userGrantsLoadable.state === "loading"
  ) {
    return <PermissionListSkeleton />;
  }

  if (userGrantsLoadable.state === "hasError") {
    return <PermissionGrantsError />;
  }

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-4">
      {connectedConnectors.length === 0 ? (
        <NoConnectedConnectors />
      ) : (
        <>
          <ConnectedConnectorPermissions
            filteredConnectors={filteredConnectors}
            authorizedSet={authorizedSet}
            search={search}
            setSearch={setSearch}
            searchActive={searchActive}
            setSearchActive={setSearchActive}
            savingConnectorRef={savingRef}
            canManagePermissions={canManagePermissions}
            onToggle={handleToggle}
            onManage={setConnectorRef}
          />
          <AgentPermissionsDrawer
            targetId={agentId}
            connectorRef={connectorRef}
            connectorLabel={connectorLabel}
            displayName={displayName}
            initialPolicies={drawerInitialPolicies}
            initialGrants={activeUserGrantSnapshot.grants}
            resetEnabled
            readOnly={!canManagePermissions}
            onApply={async (intent, { metadata }) => {
              if (connectorRef === null) {
                throw new Error("Cannot save permissions without a connector");
              }
              await savePermissionDraftPolicies({
                scope: { agentId },
                connectorRef,
                metadata,
                initialPolicies: drawerInitialPolicies,
                initialGrants: activeUserGrantSnapshot.grants,
                intent,
                pageSignal,
                applyGrantPolicies,
              });
              toast.success(
                t(($) => {
                  return $.authorization.permissionsUpdated;
                }),
              );
            }}
            onClose={() => {
              return setConnectorRef(null);
            }}
          />
        </>
      )}
    </div>
  );
}

function JobInstructionsTab() {
  const { t } = useTranslation("agents");
  const pageSignal = useGet(pageSignal$);
  const instructionsLoadable = useLoadable(agentInstructions$);
  const editedLoadable = useLoadable(agentEditedContent$);
  const dirtyLoadable = useLoadable(agentInstructionsDirty$);
  const [buildLoadable, build] = useLoadableSet(buildAgentInstructions$);

  const instructions =
    instructionsLoadable.state === "hasData" ? instructionsLoadable.data : null;
  const loading = instructionsLoadable.state === "loading";
  const fetchError = loadableErrorMessage(
    instructionsLoadable,
    t(($) => {
      return $.errors.unknown;
    }),
  );
  const edited =
    editedLoadable.state === "hasData" ? editedLoadable.data : null;
  const isDirty =
    dirtyLoadable.state === "hasData" && dirtyLoadable.data === true;
  const isBuilding = buildLoadable.state === "loading";
  const buildError =
    buildLoadable.state === "hasError" ? String(buildLoadable.error) : null;

  const setEdited = useSet(setAgentEditedContent$);
  const discard = useSet(discardAgentEdit$);

  return (
    <ZeroInstructionsTab
      instructions={instructions}
      loading={loading}
      fetchError={fetchError}
      editedContent={edited}
      isDirty={isDirty}
      isBuilding={isBuilding}
      buildError={buildError}
      onEdit={setEdited}
      onDiscard={discard}
      onBuild={() => {
        detach(
          (async () => {
            await build(pageSignal);
            toast.success(
              t(($) => {
                return $.instructions.saved;
              }),
            );
          })(),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function AgentHeader({
  displayName,
  description,
  agentId,
  activeTab,
  onTabChange,
  showProfileAndInstructions,
}: {
  displayName: string;
  description: string;
  agentId: string;
  activeTab: string;
  onTabChange: (tab: string) => void;
  showProfileAndInstructions: boolean;
}) {
  const { t } = useTranslation("agents");
  const nav = useSet(detachedNavigateTo$);
  const openMaker = useSet(openAvatarMaker$);

  return (
    <DetailPageHeader>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-4">
          <div className="group relative shrink-0">
            <AgentAvatarImg
              name={agentId}
              alt={displayName}
              className="h-14 w-14 shrink-0 rounded-full object-cover object-top sm:h-16 sm:w-16"
            />
            {showProfileAndInstructions && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        onTabChange("profile");
                        openMaker();
                      }}
                      className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
                      aria-label={t(($) => {
                        return $.avatar.actions.customize;
                      })}
                    >
                      <IconWand size={12} stroke={1.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">
                      {t(($) => {
                        return $.avatar.actions.customize;
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl truncate">
              {displayName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 leading-tight line-clamp-2">
              {description ||
                t(($) => {
                  return $.detail.defaultDescription;
                })}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="zero-btn-morandi max-w-[220px] shrink-0 gap-1.5"
          onClick={() => {
            nav("/agents/:agentId/chat", {
              pathParams: { agentId: agentId },
            });
          }}
          aria-label={t(
            ($) => {
              return $.detail.chatWith;
            },
            { agentName: displayName },
          )}
        >
          <IconMessageCircle size={14} stroke={2} className="shrink-0" />
          <span className="truncate">
            {t(
              ($) => {
                return $.detail.chatWith;
              },
              { agentName: displayName },
            )}
          </span>
        </Button>
      </div>

      <div className="mt-4 sm:mt-6 flex items-center gap-2">
        <AgentTabNav
          activeTab={activeTab}
          onTabChange={onTabChange}
          showProfileAndInstructions={showProfileAndInstructions}
        />
      </div>
    </DetailPageHeader>
  );
}

// Wraps the shared settings tab with agent-scoped data so the delete dialog can
// offer to copy bound workflows onto another agent before the agent is removed.
function AgentProfileSettings({
  agentId,
  displayName,
  description,
  avatarUrl,
  resolvedSound,
  isDefaultAgent,
  visibility,
  canEditVisibility,
  onDelete,
}: {
  agentId: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  isDefaultAgent: boolean;
  visibility: "public" | "private";
  canEditVisibility: boolean;
  onDelete: () => Promise<void>;
}) {
  const pageSignal = useGet(pageSignal$);
  const workflowsLoadable = useLastLoadable(currentAgentVisibleWorkflows$);
  const agentsLoadable = useLoadable(agents$);
  const [, copyWorkflow] = useLoadableSet(copyWorkflow$);

  const deleteWorkflows =
    workflowsLoadable.state === "hasData"
      ? workflowsLoadable.data.map((workflow) => {
          return {
            id: workflow.id,
            title: workflow.displayName ?? workflow.name,
          };
        })
      : [];
  const deleteCopyTargets =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data
          .filter((agent) => {
            return agent.id !== agentId;
          })
          .map((agent) => {
            return { id: agent.id, displayName: agent.displayName };
          })
      : [];

  const copyWorkflowBeforeDelete = async (
    workflowId: string,
    toAgentId: string,
  ) => {
    await copyWorkflow({ workflowId, toAgentId }, pageSignal);
  };

  return (
    <ZeroSettingsTab
      key={agentId}
      agentId={agentId}
      displayName={displayName}
      description={description}
      sound={resolvedSound}
      avatarUrl={avatarUrl}
      visibility={visibility}
      canEditVisibility={canEditVisibility}
      updateSettings$={updateAgentSettings$}
      inputId="job-agent-name"
      isDefaultAgent={isDefaultAgent}
      onDelete={onDelete}
      deleteWorkflows={deleteWorkflows}
      deleteCopyTargets={deleteCopyTargets}
      onCopyWorkflowBeforeDelete={copyWorkflowBeforeDelete}
    />
  );
}

function AgentTabContent({
  activeTab,
  agentId,
  displayName,
  description,
  avatarUrl,
  resolvedSound,
  isDefaultAgent,
  visibility,
  canEditVisibility,
}: {
  activeTab: string;
  agentId: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  isDefaultAgent: boolean;
  visibility: "public" | "private";
  canEditVisibility: boolean;
}) {
  const deleteAgent = useSet(deleteAgent$);
  const nav = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);

  const handleDelete = async () => {
    await deleteAgent(pageSignal);
    nav("/agents");
  };

  switch (activeTab) {
    case "authorization": {
      return <JobPermissionsTab agentId={agentId} displayName={displayName} />;
    }
    case "profile": {
      return (
        <AgentProfileSettings
          agentId={agentId}
          displayName={displayName}
          description={description}
          avatarUrl={avatarUrl}
          resolvedSound={resolvedSound}
          isDefaultAgent={isDefaultAgent}
          visibility={visibility}
          canEditVisibility={canEditVisibility}
          onDelete={handleDelete}
        />
      );
    }
    case "instructions": {
      return <JobInstructionsTab />;
    }
    default: {
      return null;
    }
  }
}

function useAgentFields() {
  const { t } = useTranslation("agents");
  const agent = useLastResolved(currentAgent$);
  const detail = useLastResolved(agentDetail$);
  // Both signals fetch from zeroAgentsByIdContract; pick whichever resolved first
  const source = agent ?? detail;
  if (!source) {
    return {
      detail: detail ?? null,
      agentId: "",
      displayName: t(($) => {
        return $.fallbackName;
      }),
      description: "",
      avatarUrl: null,
      resolvedSound: resolveSound("professional"),
      ownerId: "",
      visibility: "public" as const,
    };
  }
  return {
    detail: detail ?? null,
    agentId: source.agentId,
    displayName:
      source.displayName ??
      (source.agentId ||
        t(($) => {
          return $.fallbackName;
        })),
    description: source.description ?? "",
    avatarUrl: source.avatarUrl,
    resolvedSound: resolveSound(source.sound ?? "professional"),
    ownerId: source.ownerId,
    visibility: source.visibility ?? "public",
  };
}

function useTabVisibility(agentId: string, ownerId: string) {
  const statusLoadable = useLastLoadable(zeroOnboardingStatus$);
  const isDefaultAgent =
    statusLoadable.state === "hasData" &&
    statusLoadable.data.defaultAgentId === agentId;

  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;

  const userLoadable = useLoadable(user$);
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isOwner = currentUserId === ownerId;

  const rawTab = useGet(agentActiveTab$);
  const setActiveTab = useSet(setAgentActiveTab$);
  const hideProfileAndInstructions = !isAdmin && !isOwner;
  const activeTab = resolveVisibleTab(rawTab, hideProfileAndInstructions);

  return {
    isDefaultAgent,
    hideProfileAndInstructions,
    isOwner,
    activeTab,
    setActiveTab,
  };
}

export function ZeroJobDetailPage() {
  const { t } = useTranslation("agents");
  const detailLoadable = useLoadable(agentDetail$);
  const error = loadableErrorMessage(
    detailLoadable,
    t(($) => {
      return $.errors.unknown;
    }),
  );
  const currentAgentId = useGet(currentAgentId$);
  const fields = useAgentFields();
  const errorAgentId = fields.agentId || currentAgentId || "";
  const {
    isDefaultAgent,
    hideProfileAndInstructions,
    isOwner,
    activeTab,
    setActiveTab,
  } = useTabVisibility(fields.agentId, fields.ownerId);

  if (!fields.detail && !error) {
    return <DetailSkeleton />;
  }

  if (error) {
    return <DetailError error={error} agentId={errorAgentId} />;
  }

  return (
    <DetailPageShell>
      <Breadcrumb currentName={fields.displayName} />
      <AgentHeader
        displayName={fields.displayName}
        description={fields.description}
        agentId={fields.agentId}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        showProfileAndInstructions={!hideProfileAndInstructions}
      />
      <DetailPageMain>
        <AgentTabContent
          activeTab={activeTab}
          agentId={fields.agentId}
          displayName={fields.displayName}
          description={fields.description}
          avatarUrl={fields.avatarUrl}
          resolvedSound={fields.resolvedSound}
          isDefaultAgent={isDefaultAgent}
          visibility={fields.visibility}
          canEditVisibility={isOwner}
        />
      </DetailPageMain>
    </DetailPageShell>
  );
}
