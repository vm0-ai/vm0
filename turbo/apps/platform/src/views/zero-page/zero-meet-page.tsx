import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconMessageCircle,
  IconUser,
  IconFileText,
  IconPlug,
  IconPlus,
  IconCalendar,
  IconPencil,
  IconLoader2,
  IconCrown,
  IconDotsVertical,
} from "@tabler/icons-react";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons";
import {
  Card,
  CardContent,
  Input,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  cn,
} from "@vm0/ui";
import { ZeroScheduleCard, DEFAULT_SCHEDULE } from "./zero-schedule-card";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { setPendingChatPrompt$ } from "../../signals/zero-page/zero-nav.ts";
import {
  allConnectorTypes$,
  addConnectionDialogOpen$,
  setAddConnectionDialogOpen$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  pollingConnectorType$,
} from "../../signals/settings-page/connectors.ts";
import { deleteConnector$ } from "../../signals/external/connectors.ts";
import {
  AddConnectionDialog,
  ConnectModal,
} from "../settings-page/add-connection-dialog.tsx";
import { detach, Reason } from "../../signals/utils.ts";

const TONE_OPTIONS = [
  "Professional",
  "Friendly",
  "Direct",
  "Supportive",
] as const;

const TONE_HINT: Readonly<Record<(typeof TONE_OPTIONS)[number], string>> = {
  Professional: "Clear and polished",
  Friendly: "Warm and approachable",
  Direct: "To the point",
  Supportive: "In your corner",
};

const TONE_SAMPLES: Readonly<
  Record<
    (typeof TONE_OPTIONS)[number],
    Readonly<{ user: string; zero: string }>
  >
> = {
  Professional: {
    user: "I need the Q3 report by Friday.",
    zero: "I'll have the Q3 report ready by Friday. I'll send a draft by Thursday for your review.",
  },
  Friendly: {
    user: "I need the Q3 report by Friday.",
    zero: "Sure thing! I'll get that Q3 report to you by Friday—I'll send over a draft Thursday so you can take a look.",
  },
  Direct: {
    user: "I need the Q3 report by Friday.",
    zero: "Friday. I'll send a draft Thursday.",
  },
  Supportive: {
    user: "I need the Q3 report by Friday.",
    zero: "I'll make sure you have the Q3 report by Friday. I'll send a draft on Thursday so you have time to review—let me know if you'd like anything else.",
  },
};

// ---------------------------------------------------------------------------
// Connections tab — real connector status + OAuth connect
// ---------------------------------------------------------------------------

function ZeroConnectionsTab() {
  const DUMMY_SKILL_ITEMS: {
    type: ConnectorType;
    label: string;
    description: string;
    connected: boolean;
    showApiKey?: boolean;
  }[] = [
    {
      type: "notion",
      label: "Notion",
      description:
        "Connect your Notion workspace to access pages and databases",
      connected: true,
    },
    {
      type: "github",
      label: "GitHub",
      description:
        "Sign in with GitHub to manage repos, issues, and pull requests",
      connected: false,
    },
    {
      type: "axiom",
      label: "Axiom",
      description: "Query logs, manage datasets, and access observability data",
      connected: true,
    },
    {
      type: "ahrefs",
      label: "Ahrefs",
      description: "Access SEO data, backlink analysis, and keyword research",
      connected: false,
      showApiKey: true,
    },
  ];
  const allTypesLoadable = useLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const disconnect = useSet(deleteConnector$);
  const addDialogOpen = useGet(addConnectionDialogOpen$);
  const setAddDialogOpen = useSet(setAddConnectionDialogOpen$);
  const selectedType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);
  const removedDummyTypes$ = useCCState<ConnectorType[]>([]);
  const removedDummyTypes = useGet(removedDummyTypes$);
  const setRemovedDummyTypes = useSet(removedDummyTypes$);
  const ahrefsApiKeyDialogOpen$ = useCCState(false);
  const ahrefsApiKeyDialogOpen = useGet(ahrefsApiKeyDialogOpen$);
  const setAhrefsApiKeyDialogOpen = useSet(ahrefsApiKeyDialogOpen$);
  const ahrefsApiKeyToken$ = useCCState("");
  const ahrefsApiKeyToken = useGet(ahrefsApiKeyToken$);
  const setAhrefsApiKeyToken = useSet(ahrefsApiKeyToken$);

  const allTypes =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectedItems = allTypes.filter(
    (item) => item.connected || pollingType === item.type,
  );
  const dummyItemsFiltered = DUMMY_SKILL_ITEMS.filter(
    (item) => !removedDummyTypes.includes(item.type),
  );
  const displayItems =
    connectedItems.length > 0
      ? connectedItems.map((item) => ({
          type: item.type,
          label: item.label,
          description: item.helpText ?? "",
          statusText:
            item.connected && item.connector?.externalUsername
              ? `Connected as @${item.connector.externalUsername}`
              : "Connected",
          isDummy: false,
          isPolling: pollingType === item.type,
          connected: true,
          showApiKey: false,
        }))
      : dummyItemsFiltered.map((item) => ({
          type: item.type,
          label: item.label,
          description: item.description,
          statusText: item.connected ? "Connected as ming@vm0.ai" : "",
          isDummy: true,
          isPolling: false,
          connected: item.connected,
          showApiKey: item.showApiKey ?? false,
        }));

  return (
    <div className="mx-auto max-w-[900px] px-7 flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Skills manage your connections and help you get more out of these
        services.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add skill */}
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-border/80 transition-colors hover:border-border hover:bg-muted/30 group"
        >
          <div className="flex h-14 items-center gap-2.5 px-5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center">
              <IconPlus
                size={18}
                stroke={2}
                className="text-muted-foreground group-hover:text-foreground"
              />
            </span>
            <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">
              Add skill
            </span>
          </div>
          <div className="flex h-11 items-center border-t border-dashed border-border/80 px-5 group-hover:border-border">
            <span className="text-xs text-muted-foreground/70">
              Browse 100+ popular skills
            </span>
          </div>
        </button>

        {/* Connector cards */}
        {displayItems.map((item) => (
          <div
            key={item.type}
            className="flex flex-col rounded-[var(--zero-card-radius)] border border-[var(--zero-card-border)] bg-card shadow-[var(--zero-card-shadow)]"
          >
            <div className="flex h-14 items-center gap-2.5 px-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <ConnectorIcon type={item.type} size={22} />
              </span>
              <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                {item.label}
              </span>
            </div>

            <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
              <div className="flex items-center gap-2 min-w-0">
                {item.isPolling ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <IconLoader2
                      size={12}
                      stroke={1.5}
                      className="animate-spin"
                    />
                    Connecting…
                  </span>
                ) : item.connected ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    {item.statusText}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setSelected(item.type)}
                      className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                    >
                      Connect
                    </button>
                    {item.showApiKey && (
                      <>
                        <span className="text-xs text-muted-foreground">
                          or
                        </span>
                        <button
                          type="button"
                          onClick={() => setAhrefsApiKeyDialogOpen(true)}
                          className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                        >
                          API key
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
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
                <DropdownMenuContent align="end" className="w-40">
                  {item.connected ? (
                    <DropdownMenuItem
                      onClick={() =>
                        !item.isDummy &&
                        detach(disconnect(item.type), Reason.DomCallback)
                      }
                    >
                      Disconnect
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        setRemovedDummyTypes((prev) =>
                          prev.includes(item.type)
                            ? prev
                            : [...prev, item.type],
                        )
                      }
                    >
                      Remove skill
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>

      <AddConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        variant="zero"
      />

      {selectedType && <ConnectModal onClose={() => setSelected(null)} />}

      <Dialog
        open={ahrefsApiKeyDialogOpen}
        onOpenChange={setAhrefsApiKeyDialogOpen}
      >
        <DialogContent className="zero-app zero-card border border-[var(--zero-card-border)] rounded-[var(--zero-card-radius)] shadow-[var(--zero-card-shadow)] sm:max-w-md gap-0 p-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-4 flex flex-row items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted overflow-hidden">
              <ConnectorIcon type="ahrefs" size={24} />
            </span>
            <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
              Ahrefs API key
            </DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-6 flex flex-col gap-5">
            <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
              <li>
                Log in to your{" "}
                <a
                  href="https://app.ahrefs.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2 hover:opacity-80"
                >
                  Ahrefs Dashboard
                </a>
              </li>
              <li>
                Go to{" "}
                <strong className="text-foreground font-medium">
                  API keys
                </strong>{" "}
                under your account settings
              </li>
              <li>Generate a new API token</li>
              <li>Copy the token</li>
            </ol>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="ahrefs-api-token"
                className="text-sm font-medium text-foreground"
              >
                API Token
              </label>
              <Input
                id="ahrefs-api-token"
                value={ahrefsApiKeyToken}
                onChange={(e) => setAhrefsApiKeyToken(e.target.value)}
                placeholder="your-ahrefs-api-token"
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <DialogFooter className="px-6 pb-6 pt-0">
            <Button
              className="zero-btn-morandi h-9 rounded-lg border px-4"
              onClick={() => setAhrefsApiKeyDialogOpen(false)}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main meet page
// ---------------------------------------------------------------------------

interface ZeroMeetPageProps {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
  onNavigateToChat?: () => void;
}

export function ZeroMeetPage({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
  onNavigateToChat,
}: ZeroMeetPageProps) {
  const setPrompt = useSet(setPendingChatPrompt$);
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const resolvedAgentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const activeTab$ = useCCState("connections");
  const activeTab = useGet(activeTab$);
  const setActiveTab = useSet(activeTab$);
  const agentName$ = useCCState(resolvedAgentName);
  const agentName = useGet(agentName$);
  const setAgentName = useSet(agentName$);
  const tone$ = useCCState<string>("Professional");
  const tone = useGet(tone$);
  const setTone = useSet(tone$);
  const savedSettings$ = useCCState<{
    name: string;
    tone: string;
  }>({
    name: resolvedAgentName,
    tone: "Professional",
  });
  const savedSettings = useGet(savedSettings$);
  const setSavedSettings = useSet(savedSettings$);

  const isSettingsDirty =
    agentName !== savedSettings.name || tone !== savedSettings.tone;
  const showSaveBar = isSettingsDirty;

  const handleResetSettings = () => {
    setAgentName(savedSettings.name);
    setTone(savedSettings.tone);
  };

  const handleSaveSettings = () => {
    setSavedSettings({
      name: agentName,
      tone,
    });
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px] px-7">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onAvatarClick}
              className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch Zero avatar"
            >
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
              />
            </button>
            <div className="min-w-0 pt-2 sm:pt-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-foreground leading-tight">
                  {resolvedAgentName}
                </h1>
                <span className="zero-pill inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium">
                  <IconCrown
                    size={12}
                    stroke={1.8}
                    className="shrink-0 text-blue-600"
                  />
                  Super agent
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5 leading-tight">
                Your AI teammate, tuned to you
              </p>
            </div>
          </div>

          <div className="mt-6 flex h-9 items-center justify-between gap-6">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="flex-1 min-w-0"
            >
              <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1">
                <TabsTrigger
                  value="connections"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconPlug size={14} stroke={1.5} />
                  Skills
                </TabsTrigger>
                <TabsTrigger
                  value="schedule"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconCalendar size={14} stroke={1.5} />
                  Schedule
                </TabsTrigger>
                <TabsTrigger
                  value="settings"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconUser size={14} stroke={1.5} />
                  Settings
                </TabsTrigger>
                <TabsTrigger
                  value="instructions"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconFileText size={14} stroke={1.5} />
                  Instructions
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border px-4"
                    onClick={() => {
                      setPrompt(
                        `Help me update ${agentName}'s skills configuration and settings`,
                      );
                      onNavigateToChat?.();
                    }}
                  >
                    <IconMessageCircle size={14} stroke={1.5} />
                    Chat with {agentName}
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="max-w-[220px] text-center"
                >
                  Make updates or assign tasks
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </header>

      <main
        className={cn(
          "shrink-0 px-4 sm:px-6 pt-4",
          showSaveBar ? "pb-24" : "pb-16",
        )}
      >
        {activeTab === "schedule" && (
          <div className="mx-auto max-w-[900px] px-7">
            <ZeroScheduleCard
              title={`${resolvedAgentName}'s schedule`}
              subtitle={`Set a time and prompt for ${resolvedAgentName} to run automatically.`}
              initialSchedule={DEFAULT_SCHEDULE}
            />
          </div>
        )}

        {activeTab === "settings" && (
          <div className="mx-auto max-w-[900px] px-7">
            <Card className="zero-card">
              <CardContent className="py-5 flex flex-col gap-4">
                <div className="flex flex-col gap-8">
                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor="zero-agent-name"
                      className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      Name
                    </label>
                    <Input
                      id="zero-agent-name"
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      placeholder="What should we call them?"
                      className="h-9"
                    />
                  </div>
                  <div
                    className="flex flex-col gap-2"
                    role="group"
                    aria-label={`How ${resolvedAgentName} sounds`}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      How they sound
                    </span>
                    <div
                      className="flex flex-wrap gap-2"
                      role="group"
                      aria-label="Tone"
                    >
                      {TONE_OPTIONS.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setTone(opt)}
                          className={cn(
                            "rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            tone === opt
                              ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                              : "zero-chip text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                    <div
                      className="zero-chip rounded-lg border px-3 py-2 transition-colors duration-200"
                      key={tone}
                    >
                      <p className="text-xs text-muted-foreground italic min-h-[1.25rem] leading-relaxed">
                        {TONE_HINT[tone as (typeof TONE_OPTIONS)[number]]}
                      </p>
                      <div className="my-2 border-t border-border/30" />
                      <div className="flex flex-col gap-1.5 pb-1.5">
                        <div className="flex justify-end">
                          <div className="zero-bubble-cool max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed transition-colors duration-200">
                            {
                              TONE_SAMPLES[
                                tone as (typeof TONE_OPTIONS)[number]
                              ].user
                            }
                          </div>
                        </div>
                        <div className="flex justify-start">
                          <div className="zero-chat-bubble-assistant max-w-[85%] rounded-2xl border px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200">
                            {
                              TONE_SAMPLES[
                                tone as (typeof TONE_OPTIONS)[number]
                              ].zero
                            }
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "instructions" && (
          <div className="mx-auto max-w-[900px] px-7">
            <Card className="zero-card-white">
              <CardContent className="py-7">
                <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 sm:items-end">
                  <div className="space-y-5 text-sm text-foreground leading-relaxed flex-1 min-w-0">
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Expertise
                      </h2>
                      <p>
                        {resolvedAgentName} is an intelligent Super Manager
                        designed to help teams with automation, data analysis,
                        and workflow orchestration.
                      </p>
                    </div>
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Communication Style
                      </h2>
                      <p>
                        Professional and clear communication, with a focus on
                        actionable insights.
                      </p>
                    </div>
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Core Capabilities
                      </h2>
                      <ul className="list-disc pl-4 space-y-0.5">
                        <li>Web research and information gathering</li>
                        <li>Code execution and analysis</li>
                        <li>File processing and data analysis</li>
                        <li>Workflow automation</li>
                      </ul>
                    </div>
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Behavior Guidelines
                      </h2>
                      <ul className="list-disc pl-4 space-y-0.5">
                        <li>Provide concise, actionable responses</li>
                        <li>Ask clarifying questions when needed</li>
                        <li>Present information in a structured format</li>
                        <li>Maintain context across conversations</li>
                      </ul>
                    </div>
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Response Format
                      </h2>
                      <p className="mb-1">When responding:</p>
                      <ol className="list-decimal pl-4 space-y-0.5">
                        <li>Acknowledge the request</li>
                        <li>Provide relevant information or analysis</li>
                        <li>Suggest next steps when appropriate</li>
                        <li>Ask for clarification if needed</li>
                      </ol>
                    </div>
                  </div>
                </div>
                <p className="text-muted-foreground text-xs pt-5 mt-5 border-t border-border/60">
                  Edit the instructions directly to customize your agent&apos;s
                  behavior.
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "connections" && <ZeroConnectionsTab />}
      </main>

      {showSaveBar &&
        createPortal(
          <div className="zero-app fixed bottom-6 left-0 right-0 z-50 flex justify-center px-4 sm:left-[255px]">
            <div className="zero-card flex max-w-md items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4 shadow-lg">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <IconPencil
                  size={18}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <span>You have unsaved changes</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={handleResetSettings}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={handleSaveSettings}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
