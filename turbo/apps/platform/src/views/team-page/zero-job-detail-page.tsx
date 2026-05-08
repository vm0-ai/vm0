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
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { isMobileViewport$ } from "../../signals/zero-page/mobile-viewport.ts";
import {
  IconFileText,
  IconUserCircle,
  IconShield,
  IconCalendar,
  IconUsers,
  IconAdjustmentsHorizontal,
  IconSearch,
  IconX,
  IconMessageCircle,
  IconWand,
  IconChevronRight,
} from "@tabler/icons-react";
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
import { ZeroScheduleTab } from "../zero-page/zero-schedule-tab.tsx";
import { ZeroInstructionsTab } from "../zero-page/zero-instructions-tab.tsx";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { ZeroSettingsTab } from "../zero-page/zero-settings-tab.tsx";

import { TONE_OPTIONS, type Tone } from "../zero-page/zero-tone-constants.ts";
import type { ScheduleEntry } from "../zero-page/zero-schedule-card.tsx";
import {
  agentDetail$,
  agentInstructions$,
  agentScheduleEntries$,
  saveAgentSchedule$,
  deleteAgentSchedule$,
  toggleAgentScheduleEnabled$,
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
  type AgentTabKey,
  agentPermissionPolicies$,
  reloadAgentDetail$,
} from "../../signals/zero-page/zero-job-detail.ts";
import { runScheduleNow$ } from "../../signals/zero-page/zero-schedule.ts";
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
import { currentAgent$ } from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { user$ } from "../../signals/auth.ts";
import { ZeroNoPermissionIllustration } from "../zero-page/components/zero-no-permission-illustration.tsx";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { PermissionsDrawer } from "../zero-page/components/settings/permissions-dialog.tsx";
import noConnectorImg from "../zero-page/assets/no-connector.webp";
import { JobCustomConnectorsSection } from "./job-custom-connectors-section.tsx";
import {
  hasConnectorPermissions,
  savePermissionPolicies$,
} from "../../signals/zero-page/settings/permissions.ts";
import {
  allConnectorTypes$,
  matchesConnectorSearch,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  permConnectorType$,
  setPermConnectorType$,
  permSearch$,
  setPermSearch$,
  permSearchActive$,
  setPermSearchActive$,
  permSavingType$,
  setPermSavingType$,
} from "../../signals/zero-page/zero-job-detail-page.ts";

// ---------------------------------------------------------------------------
// Page shell: skeleton, error, header
// ---------------------------------------------------------------------------

function loadableErrorMessage(loadable: {
  state: string;
  error?: unknown;
}): string | null {
  if (loadable.state !== "hasError") {
    return null;
  }
  return loadable.error instanceof Error
    ? loadable.error.message
    : "Unknown error";
}

function Breadcrumb({
  currentName,
  className,
}: {
  currentName?: string;
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground${className ? ` ${className}` : ""}`}
    >
      <Link
        pathname="/agents"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconUsers size={14} stroke={1.5} className="shrink-0" />
        Agents
      </Link>
      <span className="text-muted-foreground/40 select-none">/</span>
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
        {currentName ?? "Agent"}
      </span>
    </nav>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Breadcrumb />
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="animate-pulse space-y-3">
            <div className="h-5 w-48 rounded bg-muted" />
            <div className="h-4 w-72 rounded bg-muted" />
            <div className="h-9 w-80 rounded bg-muted mt-4" />
          </div>
        </div>
      </header>
    </div>
  );
}

function isNotFoundError(error: string): boolean {
  return /not found|404|no(t| )exist/i.test(error);
}

function DetailError({ error, agentId }: { error: string; agentId: string }) {
  if (isNotFoundError(error)) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <Breadcrumb />
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 pb-16">
          <div className="flex flex-col items-center text-center gap-4 max-w-sm">
            <ZeroNoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                Agent not found
              </h2>
              <p className="text-[16px] sm:text-sm text-muted-foreground">
                The agent &quot;{agentId}&quot; doesn&apos;t exist or you
                don&apos;t have access to it.
              </p>
            </div>
            <Link
              pathname="/agents"
              className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
            >
              Back to team
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Breadcrumb />
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-[16px] sm:text-sm text-destructive">{error}</p>
              <Link
                pathname="/agents/:agentId"
                options={{ pathParams: { agentId: agentId } }}
                className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
              >
                Retry
              </Link>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

const TAB_TRIGGER_CLASS =
  "gap-1.5 text-[16px] sm:text-sm data-[state=active]:bg-background px-3";

/** Coerce hidden / null tabs back to "authorization" so the desktop tab view
 *  always has one tab marked active. Mobile-native uses `rawTab` directly so
 *  it can render the index (grouped list) view when `rawTab === null`. */
function resolveVisibleTab(
  rawTab: AgentTabKey | null,
  hideProfileAndInstructions: boolean,
): AgentTabKey {
  if (rawTab === null) {
    return "authorization";
  }
  if (
    hideProfileAndInstructions &&
    rawTab !== "authorization" &&
    rawTab !== "schedule"
  ) {
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
  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex-1 min-w-0"
    >
      {/* Mobile: Select dropdown */}
      <div className="sm:hidden">
        <Select value={activeTab} onValueChange={onTabChange}>
          <SelectTrigger className="h-11 w-full text-[16px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="authorization" className="text-[16px] py-2.5">
              Authorization
            </SelectItem>
            <SelectItem value="schedule" className="text-[16px] py-2.5">
              Scheduled
            </SelectItem>
            {showProfileAndInstructions && (
              <SelectItem value="profile" className="text-[16px] py-2.5">
                Profile
              </SelectItem>
            )}
            {showProfileAndInstructions && (
              <SelectItem value="instructions" className="text-[16px] py-2.5">
                Instructions
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      {/* Desktop: tab list */}
      <TabsList className="zero-tabs hidden sm:inline-flex h-9 gap-1 px-1 py-1">
        <TabsTrigger value="authorization" className={TAB_TRIGGER_CLASS}>
          <IconShield size={14} stroke={1.5} />
          Authorization
        </TabsTrigger>
        <TabsTrigger value="schedule" className={TAB_TRIGGER_CLASS}>
          <IconCalendar size={14} stroke={1.5} />
          Scheduled
        </TabsTrigger>
        {showProfileAndInstructions && (
          <TabsTrigger value="profile" className={TAB_TRIGGER_CLASS}>
            <IconUserCircle size={14} stroke={1.5} />
            Profile
          </TabsTrigger>
        )}
        {showProfileAndInstructions && (
          <TabsTrigger value="instructions" className={TAB_TRIGGER_CLASS}>
            <IconFileText size={14} stroke={1.5} />
            Instructions
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

// ---------------------------------------------------------------------------
// PermissionRow — single connector toggle row inside the authorization tab
// ---------------------------------------------------------------------------

function PermissionRow({
  connector,
  enabled,
  onToggle,
  loading,
  showManage,
  onManage,
  isLast,
}: {
  connector: ConnectorTypeWithStatus;
  enabled: boolean;
  onToggle: (checked: boolean) => void;
  loading?: boolean;
  showManage?: boolean;
  onManage?: () => void;
  isLast?: boolean;
}) {
  return (
    <>
      <div className="flex items-center gap-3 px-5 py-4 w-full text-left transition-colors">
        <ConnectorIcon type={connector.type} size={20} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[16px] sm:text-sm font-medium text-foreground">
              {connector.label}
            </span>
            {connector.connector?.externalUsername && (
              <span className="text-[16px] sm:text-xs text-muted-foreground">
                @{connector.connector.externalUsername}
              </span>
            )}
          </div>
          {connector.helpText && (
            <p className="text-[16px] sm:text-xs text-muted-foreground mt-0.5 line-clamp-1">
              {connector.helpText
                .replace(/^Connect your \w+ account to /i, "")
                .replace(/^access /i, "")
                .replace(/^create /i, "Create ")
                .replace(/^./, (c) => {
                  return c.toUpperCase();
                })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {showManage && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onManage?.();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onManage?.();
                      }
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label={`Manage ${connector.label} permissions`}
                  >
                    <IconAdjustmentsHorizontal size={15} stroke={1.5} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">Manage permissions</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <LoadingSwitch
            checked={enabled}
            onCheckedChange={(checked) => {
              return onToggle(checked);
            }}
            loading={loading}
            ariaLabel={`${enabled ? "Revoke" : "Grant"} ${connector.label} access`}
          />
        </div>
      </div>
      {!isLast && <div className="mx-5 border-b border-border/50" />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab wrappers — resolve signals into shared component props
// ---------------------------------------------------------------------------

function JobPermissionsTab({
  agentId,
  displayName,
  ownerId,
}: {
  agentId: string;
  displayName: string;
  ownerId: string;
}) {
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
  const permissionPolicies = useLastResolved(agentPermissionPolicies$) ?? null;
  const reloadDetail = useSet(reloadAgentDetail$);
  const savePermPol = useSet(savePermissionPolicies$);
  const connectorType = useGet(permConnectorType$);
  const setConnectorType = useSet(setPermConnectorType$);
  const search = useGet(permSearch$);
  const setSearch = useSet(setPermSearch$);
  const searchActive = useGet(permSearchActive$);
  const setSearchActive = useSet(setPermSearchActive$);
  const savingType = useGet(permSavingType$);
  const setSavingType = useSet(setPermSavingType$);

  const userLoadable = useLoadable(user$);
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isOwner = currentUserId === ownerId;

  const connectorsLoading = connectorsLoadable.state === "loading";

  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];

  const connectedConnectors = allConnectors.filter((c) => {
    return c.connected;
  });
  const filteredConnectors = connectedConnectors.filter((c) => {
    return matchesConnectorSearch(search, c);
  });
  const authorizedSet = new Set(authorizedConnectors);

  const handleToggle = async (type: string, checked: boolean) => {
    if (savingType !== null) {
      return;
    }
    const modify = checked
      ? authorizeFn(type, pageSignal)
      : deauthorizeFn(type, pageSignal);
    setSavingType(type);
    await bestEffort(
      (async () => {
        await modify;
        await saveConnectors(pageSignal);
        toast.success("Connectors saved");
      })(),
    );
    setSavingType(null);
  };

  if (allTypesLoadable.state !== "hasData" || connectorsLoading) {
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

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-4">
      {connectedConnectors.length === 0 ? (
        <>
          <div className="zero-card py-8 flex flex-col items-center gap-3">
            <img
              src={noConnectorImg}
              alt="No connectors"
              className="h-20 w-20 object-contain opacity-80"
            />
            <p className="text-[16px] sm:text-sm text-muted-foreground text-center">
              No connected services yet. Head to the{" "}
              <Link
                pathname="/connectors"
                className="font-medium text-foreground hover:underline"
              >
                Connectors
              </Link>{" "}
              page to connect your first service.
            </p>
          </div>
          <JobCustomConnectorsSection />
        </>
      ) : (
        <>
          <div className="zero-card">
            <div className="relative border-b border-border/50">
              <div
                className={cn(
                  "px-5 pt-4 pb-3 pr-12 text-[16px] sm:text-sm text-muted-foreground transition-opacity duration-150",
                  searchActive && "opacity-0 select-none",
                )}
                aria-hidden={searchActive}
              >
                When running, the agent can securely use your connected
                services. You can manage or turn off access anytime.
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
                    placeholder="Find connectors..."
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
                    className="flex-1 bg-transparent text-base sm:text-sm text-foreground placeholder:text-muted-foreground outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setSearchActive(false);
                    }}
                    className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label="Close search"
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
                  aria-label="Find connectors"
                >
                  <IconSearch size={14} stroke={1.5} />
                </button>
              )}
            </div>
            {filteredConnectors.length > 0 ? (
              filteredConnectors.map((c, i) => {
                return (
                  <PermissionRow
                    key={c.type}
                    connector={c}
                    enabled={authorizedSet.has(c.type)}
                    onToggle={onDomEventFn(async (checked) => {
                      await handleToggle(c.type, checked);
                    })}
                    loading={savingType === c.type}
                    showManage={hasConnectorPermissions(c.type)}
                    onManage={() => {
                      return setConnectorType(c.type);
                    }}
                    isLast={i === filteredConnectors.length - 1}
                  />
                );
              })
            ) : (
              <p className="px-5 py-4 text-[16px] sm:text-sm text-muted-foreground">
                No results for &ldquo;{search}&rdquo;
              </p>
            )}
          </div>

          <JobCustomConnectorsSection />

          {connectorType && (
            <PermissionsDrawer
              connectorType={connectorType}
              displayName={displayName}
              initialPolicies={permissionPolicies ?? {}}
              readOnly={!isOwner}
              onApply={async (policies) => {
                const saved = await savePermPol(agentId, policies, pageSignal);
                if (saved !== undefined) {
                  reloadDetail();
                }
                toast.success("Permissions updated");
              }}
              onClose={() => {
                return setConnectorType(null);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function JobScheduleTab({ displayName }: { displayName: string }) {
  const scheduleLoadable = useLoadable(agentScheduleEntries$);
  const entries = useLastResolved(agentScheduleEntries$) ?? [];
  const loading = scheduleLoadable.state === "loading";
  const scheduleError = loadableErrorMessage(scheduleLoadable);
  const saveScheduleTracked = useSet(saveAgentSchedule$);
  const deleteSchedule = useSet(deleteAgentSchedule$);
  const toggleEnabled = useSet(toggleAgentScheduleEnabled$);
  const runScheduleNow = useSet(runScheduleNow$);
  const nav = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);

  const handleRunNow = async (entry: ScheduleEntry) => {
    await runScheduleNow(entry.id, pageSignal);
  };

  const handleOpenDetails = (entry: ScheduleEntry) => {
    nav("/schedules/:scheduleId", { pathParams: { scheduleId: entry.id } });
  };

  return (
    <ZeroScheduleTab
      displayName={displayName}
      entries={entries}
      loading={loading}
      scheduleError={scheduleError}
      onSave={(params) => {
        return saveScheduleTracked(params, pageSignal);
      }}
      onDelete={(name) => {
        return deleteSchedule(name, pageSignal);
      }}
      onToggleEnabled={(params) => {
        return toggleEnabled(params, pageSignal);
      }}
      onRunNow={handleRunNow}
      onOpenDetails={handleOpenDetails}
    />
  );
}

function JobInstructionsTab() {
  const pageSignal = useGet(pageSignal$);
  const instructionsLoadable = useLoadable(agentInstructions$);
  const editedLoadable = useLoadable(agentEditedContent$);
  const dirtyLoadable = useLoadable(agentInstructionsDirty$);
  const [buildLoadable, build] = useLoadableSet(buildAgentInstructions$);

  const instructions =
    instructionsLoadable.state === "hasData" ? instructionsLoadable.data : null;
  const loading = instructionsLoadable.state === "loading";
  const fetchError = loadableErrorMessage(instructionsLoadable);
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
            toast.success("Instructions saved");
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
  const nav = useSet(detachedNavigateTo$);
  const openMaker = useSet(openAvatarMaker$);

  return (
    <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-0">
      <div className="mx-auto max-w-[900px]">
        {/* Mobile (max-md): centered hero — large avatar + centered name and
            tagline, iOS Settings profile pattern. Desktop keeps the existing
            left-aligned row. */}
        <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:items-center sm:gap-4 sm:text-left">
          <div className="group relative shrink-0">
            <AgentAvatarImg
              name={agentId}
              alt={displayName}
              className="h-20 w-20 shrink-0 rounded-full object-cover object-top sm:h-16 sm:w-16"
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
                      // Always visible on mobile (no hover affordance on
                      // touch); fades in on hover at sm+ to keep the desktop
                      // layout unchanged.
                      className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border transition-all hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
                      aria-label="Customize avatar"
                    >
                      <IconWand size={12} stroke={1.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">Customize avatar</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="min-w-0 w-full sm:w-auto">
            <h1 className="hidden sm:block text-lg font-semibold tracking-tight text-foreground sm:text-xl truncate">
              {displayName}
            </h1>
            <p className="text-[16px] sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-snug line-clamp-2">
              {description || "Your AI teammate, tuned to you"}
            </p>
          </div>
        </div>

        <div className="mt-4 sm:mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
          <AgentTabNav
            activeTab={activeTab}
            onTabChange={onTabChange}
            showProfileAndInstructions={showProfileAndInstructions}
          />
          <Button
            variant="outline"
            size="sm"
            className="zero-btn-morandi order-first sm:order-none gap-1.5 w-full sm:w-auto sm:shrink-0 h-11 sm:h-9 text-[16px] sm:text-sm"
            onClick={() => {
              nav("/agents/:agentId/chat", {
                pathParams: { agentId: agentId },
              });
            }}
            aria-label={`Chat with ${displayName}`}
          >
            <IconMessageCircle size={16} stroke={2} />
            Chat with {displayName}
          </Button>
        </div>
      </div>
    </header>
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
  ownerId,
  modelProviderId,
  selectedModel,
  preferPersonalProvider,
}: {
  activeTab: string;
  agentId: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  isDefaultAgent: boolean;
  ownerId: string;
  modelProviderId: string | null;
  selectedModel: string | null;
  preferPersonalProvider: boolean;
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
      return (
        <JobPermissionsTab
          agentId={agentId}
          displayName={displayName}
          ownerId={ownerId}
        />
      );
    }
    case "schedule": {
      return <JobScheduleTab displayName={displayName} />;
    }
    case "profile": {
      return (
        <ZeroSettingsTab
          key={`${displayName}\0${description}\0${resolvedSound}\0${avatarUrl}\0${modelProviderId ?? ""}\0${selectedModel ?? ""}\0${preferPersonalProvider ? "1" : "0"}`}
          displayName={displayName}
          description={description}
          sound={resolvedSound}
          avatarUrl={avatarUrl}
          modelProviderId={modelProviderId}
          selectedModel={selectedModel}
          preferPersonalProvider={preferPersonalProvider}
          updateSettings$={updateAgentSettings$}
          inputId="job-agent-name"
          isDefaultAgent={isDefaultAgent}
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
  const agent = useLastResolved(currentAgent$);
  const detail = useLastResolved(agentDetail$);
  // Both signals fetch from zeroAgentsByIdContract; pick whichever resolved first
  const source = agent ?? detail;
  if (!source) {
    return {
      detail: detail ?? null,
      agentId: "",
      displayName: "Agent",
      description: "",
      avatarUrl: null,
      resolvedSound: resolveSound("professional"),
      ownerId: "",
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    };
  }
  return {
    detail: detail ?? null,
    agentId: source.agentId,
    displayName: source.displayName ?? (source.agentId || "Agent"),
    description: source.description ?? "",
    avatarUrl: source.avatarUrl,
    resolvedSound: resolveSound(source.sound ?? "professional"),
    ownerId: source.ownerId,
    modelProviderId: source.modelProviderId,
    selectedModel: source.selectedModel,
    preferPersonalProvider: source.preferPersonalProvider,
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
    rawTab,
    activeTab,
    setActiveTab,
  };
}

// ---------------------------------------------------------------------------
// Mobile-native (MobileNativeV1) layout — iOS Settings-style index with
// grouped section rows. Tapping a row sets the activeTab; the page then
// renders that section's content with the top bar handling section title +
// "back to overview" navigation.
// ---------------------------------------------------------------------------

function MobileSectionRow({
  icon,
  label,
  onClick,
  testId,
  isLast,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
  isLast?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className="flex items-center gap-3 px-5 py-4 w-full text-left transition-colors hover:bg-muted/50 active:bg-muted"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-200 text-foreground/70">
          {icon}
        </span>
        <span className="flex-1 min-w-0 text-[16px] font-medium text-foreground">
          {label}
        </span>
        <IconChevronRight
          size={18}
          stroke={1.5}
          className="text-muted-foreground/50 shrink-0"
        />
      </button>
      {!isLast && <div className="mx-5 border-b border-border/50" />}
    </>
  );
}

function MobileAgentIndexView({
  agentId,
  displayName,
  description,
  showProfileAndInstructions,
}: {
  agentId: string;
  displayName: string;
  description: string;
  showProfileAndInstructions: boolean;
}) {
  const setActiveTab = useSet(setAgentActiveTab$);
  const nav = useSet(detachedNavigateTo$);
  const openMaker = useSet(openAvatarMaker$);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <main className="flex-1 px-4 pt-2 pb-16">
        <div className="mx-auto max-w-[600px] flex flex-col gap-6">
          <div className="flex flex-col items-center text-center gap-3 pt-4">
            <div className="group relative shrink-0">
              <AgentAvatarImg
                name={agentId}
                alt={displayName}
                className="h-24 w-24 rounded-full object-cover object-top"
              />
              {showProfileAndInstructions && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("profile");
                    openMaker();
                  }}
                  className="absolute -right-0.5 -bottom-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border transition-colors hover:text-foreground"
                  aria-label="Customize avatar"
                  data-testid="mobile-agent-avatar-maker"
                >
                  <IconWand size={14} stroke={1.5} />
                </button>
              )}
            </div>
            <div className="min-w-0 w-full">
              <h1
                className="text-[22px] font-semibold tracking-tight text-foreground truncate"
                data-testid="mobile-agent-display-name"
              >
                {displayName}
              </h1>
              <p className="text-[16px] text-muted-foreground mt-1 leading-snug line-clamp-2">
                {description || "Your AI teammate, tuned to you"}
              </p>
            </div>
          </div>

          <Button
            variant="default"
            className="zero-btn-morandi w-full gap-2 h-12 text-[16px]"
            onClick={() => {
              nav("/agents/:agentId/chat", {
                pathParams: { agentId: agentId },
              });
            }}
            aria-label={`Chat with ${displayName}`}
            data-testid="mobile-agent-chat-cta"
          >
            <IconMessageCircle size={18} stroke={2} />
            Chat with {displayName}
          </Button>

          <div className="zero-card overflow-hidden">
            {showProfileAndInstructions && (
              <MobileSectionRow
                icon={<IconFileText size={18} stroke={1.5} />}
                label="Instructions"
                testId="mobile-agent-section-instructions"
                onClick={() => {
                  setActiveTab("instructions");
                }}
              />
            )}
            {showProfileAndInstructions && (
              <MobileSectionRow
                icon={<IconUserCircle size={18} stroke={1.5} />}
                label="Profile"
                testId="mobile-agent-section-profile"
                onClick={() => {
                  setActiveTab("profile");
                }}
              />
            )}
            <MobileSectionRow
              icon={<IconShield size={18} stroke={1.5} />}
              label="Connectors"
              testId="mobile-agent-section-connectors"
              onClick={() => {
                setActiveTab("authorization");
              }}
            />
            <MobileSectionRow
              icon={<IconCalendar size={18} stroke={1.5} />}
              label="Scheduled"
              testId="mobile-agent-section-scheduled"
              onClick={() => {
                setActiveTab("schedule");
              }}
              isLast
            />
          </div>
        </div>
      </main>
    </div>
  );
}

export function ZeroJobDetailPage() {
  const detailLoadable = useLoadable(agentDetail$);
  const error = loadableErrorMessage(detailLoadable);
  const fields = useAgentFields();
  const {
    isDefaultAgent,
    hideProfileAndInstructions,
    rawTab,
    activeTab,
    setActiveTab,
  } = useTabVisibility(fields.agentId, fields.ownerId);

  const features = useLastResolved(featureSwitch$);
  const mobileNativeOn = features?.[FeatureSwitchKey.MobileNativeV1] ?? false;
  const isMobile = useGet(isMobileViewport$);
  const mobileRedesign = mobileNativeOn && isMobile;

  if (!fields.detail && !error) {
    return <DetailSkeleton />;
  }

  if (error) {
    return <DetailError error={error} agentId={fields.agentId} />;
  }

  if (mobileRedesign && rawTab === null) {
    return (
      <MobileAgentIndexView
        agentId={fields.agentId}
        displayName={fields.displayName}
        description={fields.description}
        showProfileAndInstructions={!hideProfileAndInstructions}
      />
    );
  }

  if (mobileRedesign) {
    return (
      <div
        className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]"
        data-testid="mobile-agent-section-view"
      >
        <main className="flex-1 px-4 pt-4 pb-16">
          <AgentTabContent
            activeTab={activeTab}
            agentId={fields.agentId}
            displayName={fields.displayName}
            description={fields.description}
            avatarUrl={fields.avatarUrl}
            resolvedSound={fields.resolvedSound}
            isDefaultAgent={isDefaultAgent}
            ownerId={fields.ownerId}
            modelProviderId={fields.modelProviderId}
            selectedModel={fields.selectedModel}
            preferPersonalProvider={fields.preferPersonalProvider}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <Breadcrumb currentName={fields.displayName} />
      <AgentHeader
        displayName={fields.displayName}
        description={fields.description}
        agentId={fields.agentId}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab as AgentTabKey);
        }}
        showProfileAndInstructions={!hideProfileAndInstructions}
      />
      <main className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-16">
        <AgentTabContent
          activeTab={activeTab}
          agentId={fields.agentId}
          displayName={fields.displayName}
          description={fields.description}
          avatarUrl={fields.avatarUrl}
          resolvedSound={fields.resolvedSound}
          isDefaultAgent={isDefaultAgent}
          ownerId={fields.ownerId}
          modelProviderId={fields.modelProviderId}
          selectedModel={fields.selectedModel}
          preferPersonalProvider={fields.preferPersonalProvider}
        />
      </main>
    </div>
  );
}
