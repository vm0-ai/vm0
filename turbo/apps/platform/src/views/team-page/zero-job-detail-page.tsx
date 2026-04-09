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
import { pageSignal$ } from "../../signals/page-signal.ts";
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
  zeroJobDetail$,
  zeroJobInstructions$,
  zeroJobScheduleEntries$,
  saveZeroJobSchedule$,
  deleteZeroJobSchedule$,
  toggleZeroJobScheduleEnabled$,
  zeroJobEditedContent$,
  zeroJobInstructionsDirty$,
  setZeroJobEditedContent$,
  discardZeroJobEdit$,
  buildZeroJobInstructions$,
  zeroJobUpdateSettings$,
  deleteZeroJobAgent$,
  zeroJobAddedConnectors$,
  addZeroJobConnector$,
  removeZeroJobConnector$,
  saveZeroJobConnectors$,
  zeroJobActiveTab$,
  setZeroJobActiveTab$,
  zeroJobPermissionPolicies$,
  reloadJobDetail$,
} from "../../signals/zero-page/zero-job-detail.ts";
import { runScheduleNow$ } from "../../signals/zero-page/zero-schedule.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import { Link } from "../router/link.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { useAgentAvatar } from "../zero-page/zero-sidebar.tsx";
import { resolveAvatarUrl } from "../zero-page/avatar-utils.ts";
import { currentAgent$ } from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { user$ } from "../../signals/auth.ts";
import { ZeroNoPermissionIllustration } from "../zero-page/components/zero-no-permission-illustration.tsx";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { PermissionsDrawer } from "../zero-page/components/settings/permissions-dialog.tsx";
import {
  hasConnectorPermissions,
  savePermissionPolicies$,
} from "../../signals/zero-page/settings/permissions.ts";
import {
  allConnectorTypes$,
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
              <p className="text-sm text-muted-foreground">
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
              <p className="text-sm text-destructive">{error}</p>
              <Link
                pathname="/agents/:id"
                options={{ pathParams: { id: agentId } }}
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
  "gap-1.5 text-sm data-[state=active]:bg-background px-3";

/** Coerce hidden tabs back to "authorization" for non-admin default-agent view. */
function resolveVisibleTab(
  rawTab: string,
  hideProfileAndInstructions: boolean,
): string {
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
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="authorization">Authorization</SelectItem>
            <SelectItem value="schedule">Scheduled</SelectItem>
            {showProfileAndInstructions && (
              <SelectItem value="profile">Profile</SelectItem>
            )}
            {showProfileAndInstructions && (
              <SelectItem value="instructions">Instructions</SelectItem>
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
            <span className="text-sm font-medium text-foreground">
              {connector.label}
            </span>
            {connector.connector?.externalUsername && (
              <span className="text-xs text-muted-foreground">
                @{connector.connector.externalUsername}
              </span>
            )}
          </div>
          {connector.helpText && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
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
  const connectorsLoadable = useLoadable(zeroJobAddedConnectors$);
  const addedConnectors =
    connectorsLoadable.state === "hasData" ? connectorsLoadable.data : [];
  const addConnector = useSet(addZeroJobConnector$);
  const removeConnector = useSet(removeZeroJobConnector$);
  const saveConnectors = useSet(saveZeroJobConnectors$);
  const pageSignal = useGet(pageSignal$);
  const permissionPolicies =
    useLastResolved(zeroJobPermissionPolicies$) ?? null;
  const reloadDetail = useSet(reloadJobDetail$);
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
  const filteredConnectors = search
    ? connectedConnectors.filter((c) => {
        return c.label.toLowerCase().includes(search.toLowerCase());
      })
    : connectedConnectors;
  const addedSet = new Set(addedConnectors);

  const handleToggle = (type: string, checked: boolean) => {
    if (savingType !== null) {
      return;
    }
    const modify = checked
      ? addConnector(type, pageSignal)
      : removeConnector(type, pageSignal);
    setSavingType(type);
    detach(
      modify
        .then(() => {
          return saveConnectors(pageSignal);
        })
        .then(() => {
          toast.success("Connectors saved");
        })
        .finally(() => {
          setSavingType(null);
        }),
      Reason.DomCallback,
    );
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
        <div className="zero-card py-8 text-center">
          <p className="text-sm text-muted-foreground">
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
      ) : (
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
                    placeholder="Search connectors..."
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
                  aria-label="Search connectors"
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
                    enabled={addedSet.has(c.type)}
                    onToggle={(checked) => {
                      return handleToggle(c.type, checked);
                    }}
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
              <p className="px-5 py-4 text-sm text-muted-foreground">
                No results for &ldquo;{search}&rdquo;
              </p>
            )}
          </div>

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
  const scheduleLoadable = useLoadable(zeroJobScheduleEntries$);
  const entries = useLastResolved(zeroJobScheduleEntries$) ?? [];
  const loading = scheduleLoadable.state === "loading";
  const scheduleError = loadableErrorMessage(scheduleLoadable);
  const [saveLoadable, saveScheduleTracked] =
    useLoadableSet(saveZeroJobSchedule$);
  const saveError =
    saveLoadable.state === "hasError" ? String(saveLoadable.error) : null;
  const deleteSchedule = useSet(deleteZeroJobSchedule$);
  const toggleEnabled = useSet(toggleZeroJobScheduleEnabled$);
  const runScheduleNow = useSet(runScheduleNow$);
  const nav = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);

  const handleRunNow = async (entry: ScheduleEntry) => {
    await runScheduleNow(entry.id, pageSignal);
  };

  const handleOpenDetails = (entry: ScheduleEntry) => {
    nav("/schedules/:id", { pathParams: { id: entry.id } });
  };

  return (
    <ZeroScheduleTab
      displayName={displayName}
      entries={entries}
      loading={loading}
      scheduleError={scheduleError}
      saveError={saveError}
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
  const instructionsLoadable = useLoadable(zeroJobInstructions$);
  const editedLoadable = useLoadable(zeroJobEditedContent$);
  const dirtyLoadable = useLoadable(zeroJobInstructionsDirty$);
  const [buildLoadable, build] = useLoadableSet(buildZeroJobInstructions$);

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

  const setEdited = useSet(setZeroJobEditedContent$);
  const discard = useSet(discardZeroJobEdit$);

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
          build(pageSignal).then(() => {
            return toast.success("Instructions saved");
          }),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function AgentHeader({
  displayName,
  description,
  avatarUrl,
  agentId,
  activeTab,
  onTabChange,
  showProfileAndInstructions,
}: {
  displayName: string;
  description: string;
  avatarUrl: string | null;
  agentId: string;
  activeTab: string;
  onTabChange: (tab: string) => void;
  showProfileAndInstructions: boolean;
}) {
  const nav = useSet(detachedNavigateTo$);
  const agentAvatar = useAgentAvatar(agentId);
  const resolvedDbAvatar = resolveAvatarUrl(avatarUrl);
  const currentAvatar = resolvedDbAvatar ?? agentAvatar;

  return (
    <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-0">
      <div className="mx-auto max-w-[900px]">
        <div className="flex items-center gap-4">
          {currentAvatar ? (
            <img
              src={currentAvatar}
              alt={displayName}
              className="h-14 w-14 shrink-0 rounded-full object-cover object-top sm:h-16 sm:w-16"
            />
          ) : (
            <div
              className="h-14 w-14 shrink-0 rounded-full bg-muted sm:h-16 sm:w-16"
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl truncate">
              {displayName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 leading-tight line-clamp-2">
              {description || "Your AI teammate, tuned to you"}
            </p>
          </div>
        </div>

        <div className="mt-4 sm:mt-6 flex items-center gap-2">
          <AgentTabNav
            activeTab={activeTab}
            onTabChange={onTabChange}
            showProfileAndInstructions={showProfileAndInstructions}
          />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 zero-btn-morandi gap-1.5"
            onClick={() => {
              nav("/agents/:id/chat", { pathParams: { id: agentId } });
            }}
            aria-label={`Chat with ${displayName}`}
          >
            <IconMessageCircle size={14} stroke={2} />
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
}: {
  activeTab: string;
  agentId: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  isDefaultAgent: boolean;
  ownerId: string;
}) {
  const deleteAgent = useSet(deleteZeroJobAgent$);
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
          key={`${displayName}\0${description}\0${resolvedSound}\0${avatarUrl}`}
          displayName={displayName}
          description={description}
          sound={resolvedSound}
          avatarUrl={avatarUrl}
          updateSettings$={zeroJobUpdateSettings$}
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
  const detail = useLastResolved(zeroJobDetail$);
  // Both signals fetch from zeroAgentsByIdContract; pick whichever resolved first
  const source = agent ?? detail;
  const agentId = source?.agentId ?? "";
  return {
    detail: detail ?? null,
    agentId,
    displayName: source?.displayName ?? (agentId || "Agent"),
    description: source?.description ?? "",
    avatarUrl: source?.avatarUrl ?? null,
    resolvedSound: resolveSound(source?.sound ?? "professional"),
    ownerId: source?.ownerId ?? "",
  };
}

function useTabVisibility(agentId: string) {
  const statusLoadable = useLastLoadable(zeroOnboardingStatus$);
  const isDefaultAgent =
    statusLoadable.state === "hasData" &&
    statusLoadable.data.defaultAgentId === agentId;

  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;

  const rawTab = useGet(zeroJobActiveTab$);
  const setActiveTab = useSet(setZeroJobActiveTab$);
  const hideProfileAndInstructions = isDefaultAgent && !isAdmin;
  const activeTab = resolveVisibleTab(rawTab, hideProfileAndInstructions);

  return {
    isDefaultAgent,
    hideProfileAndInstructions,
    activeTab,
    setActiveTab,
  };
}

export function ZeroJobDetailPage() {
  const detailLoadable = useLoadable(zeroJobDetail$);
  const error = loadableErrorMessage(detailLoadable);
  const fields = useAgentFields();
  const {
    isDefaultAgent,
    hideProfileAndInstructions,
    activeTab,
    setActiveTab,
  } = useTabVisibility(fields.agentId);

  if (!fields.detail && !error) {
    return <DetailSkeleton />;
  }

  if (error) {
    return <DetailError error={error} agentId={fields.agentId} />;
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <Breadcrumb currentName={fields.displayName} />
      <AgentHeader
        displayName={fields.displayName}
        description={fields.description}
        avatarUrl={fields.avatarUrl}
        agentId={fields.agentId}
        activeTab={activeTab}
        onTabChange={setActiveTab}
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
        />
      </main>
    </div>
  );
}
