import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconArrowLeft,
  IconFileText,
  IconSettings,
  IconPlug,
  IconSparkles,
  IconPlus,
  IconCalendar,
  IconPencil,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Card,
  CardContent,
  Input,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  cn,
} from "@vm0/ui";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons";
import { ZeroScheduleCard, DUMMY_AGENT_SCHEDULE } from "./zero-schedule-card";

export interface JobItem {
  id: string;
  agentName: string;
  title: string;
  description: string;
  scope: "personal" | "team";
}

const DUMMY_SKILLS = [
  {
    type: "notion" as ConnectorType,
    label: "Notion",
    connected: true,
    statusText: "Connected",
  },
  {
    type: "github" as ConnectorType,
    label: "GitHub",
    connected: false,
    statusText: "",
  },
  {
    type: "axiom" as ConnectorType,
    label: "Axiom",
    connected: true,
    statusText: "Connected",
  },
  {
    type: "slack" as ConnectorType,
    label: "Slack",
    connected: false,
    statusText: "",
  },
] as const;

function SubAgentSkillsTab() {
  const removedTypes$ = useCCState<ConnectorType[]>([]);
  const removedTypes = useGet(removedTypes$);
  const setRemovedTypes = useSet(removedTypes$);
  const displayItems = DUMMY_SKILLS.filter(
    (item) => !removedTypes.includes(item.type),
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Skills manage your connections and help you get more out of these
        services.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add skill */}
        <button
          type="button"
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

        {/* Skill cards */}
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
                {item.connected ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    {item.statusText}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    Connect
                  </button>
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
                    <DropdownMenuItem>Disconnect</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        setRemovedTypes((prev) =>
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
    </div>
  );
}

interface ZeroJobDetailPageProps {
  job: JobItem;
  onBack: () => void;
}

export function ZeroJobDetailPage({ job, onBack }: ZeroJobDetailPageProps) {
  const activeTab$ = useCCState("connectors");
  const activeTab = useGet(activeTab$);
  const setActiveTab = useSet(activeTab$);
  const settingsName$ = useCCState(job.title);
  const settingsName = useGet(settingsName$);
  const setSettingsName = useSet(settingsName$);
  const settingsDescription$ = useCCState(job.description);
  const settingsDescription = useGet(settingsDescription$);
  const setSettingsDescription = useSet(settingsDescription$);

  const savedSettings$ = useCCState<{
    name: string;
    description: string;
  }>({
    name: job.title,
    description: job.description,
  });
  const savedSettings = useGet(savedSettings$);
  const setSavedSettings = useSet(savedSettings$);

  const isSettingsDirty =
    settingsName !== savedSettings.name ||
    settingsDescription !== savedSettings.description;
  const showSaveBar = isSettingsDirty;

  const handleReset = () => {
    setSettingsName(savedSettings.name);
    setSettingsDescription(savedSettings.description);
  };

  const handleSave = () => {
    setSavedSettings({
      name: settingsName,
      description: settingsDescription,
    });
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-3">
        <div className="mb-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 -ml-2"
            onClick={onBack}
            aria-label="Back to agents"
          >
            <IconArrowLeft size={20} stroke={1.5} />
          </Button>
        </div>
        <div className="mx-auto max-w-[900px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-2 text-base">
                <span className="text-muted-foreground">{job.agentName}</span>
                <span className="text-muted-foreground/50">·</span>
                <h1 className="font-semibold tracking-tight text-foreground">
                  {job.title}
                </h1>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[36rem]">
                {job.description}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border px-4"
            >
              <IconSparkles size={14} stroke={1.5} />
              Just ask
            </Button>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="mt-4 w-full"
          >
            <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1">
              <TabsTrigger
                value="connectors"
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
                <IconSettings size={14} stroke={1.5} />
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
        </div>
      </header>

      <main
        className={cn(
          "flex-1 overflow-auto px-4 sm:px-6 pt-4",
          showSaveBar ? "pb-24" : "pb-8",
        )}
      >
        <div className="mx-auto max-w-[900px]">
          {activeTab === "instructions" && (
            <Card className="zero-card-white">
              <CardContent className="px-7 py-7">
                <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 sm:items-end">
                  <div className="space-y-5 text-sm text-foreground leading-relaxed flex-1 min-w-0">
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Description
                      </h2>
                      <p>
                        This agent collects and summarizes important team
                        information every morning.
                      </p>
                    </div>
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Trigger
                      </h2>
                      <ul className="list-disc pl-4 space-y-0.5">
                        <li>Schedule: Every day at 9:00 AM</li>
                        <li>Timezone: UTC</li>
                      </ul>
                    </div>
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Steps
                      </h2>
                      <ol className="list-decimal pl-4 space-y-1">
                        <li>
                          <span className="font-medium">Fetch Messages</span>
                          <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
                            <li>
                              Source: Slack channels (#general, #engineering)
                            </li>
                            <li>Time range: Last 24 hours</li>
                          </ul>
                        </li>
                        <li>
                          <span className="font-medium">Analyze Content</span>
                          <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
                            <li>Extract key discussions</li>
                            <li>Identify action items</li>
                          </ul>
                        </li>
                      </ol>
                    </div>
                  </div>
                </div>
                <p className="text-muted-foreground text-xs pt-5 mt-5 border-t border-border/60">
                  Edit the instructions directly to customize your
                  workflow&apos;s behavior.
                </p>
              </CardContent>
            </Card>
          )}

          {activeTab === "schedule" && (
            <ZeroScheduleCard
              title={`${job.title} schedule`}
              subtitle="Set a time and prompt for this agent to run automatically."
              initialSchedule={DUMMY_AGENT_SCHEDULE}
            />
          )}

          {activeTab === "settings" && (
            <Card className="zero-card">
              <CardContent className="px-7 py-7 flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="wf-name"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Name
                  </label>
                  <Input
                    id="wf-name"
                    value={settingsName}
                    onChange={(e) => setSettingsName(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="wf-description"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Description
                  </label>
                  <textarea
                    id="wf-description"
                    value={settingsDescription}
                    onChange={(e) => setSettingsDescription(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "connectors" && <SubAgentSkillsTab />}

          {activeTab !== "instructions" &&
            activeTab !== "settings" &&
            activeTab !== "connectors" &&
            activeTab !== "schedule" && (
              <Card className="zero-card">
                <CardContent className="px-7 py-7">
                  <p className="text-sm text-muted-foreground">
                    {activeTab} — coming soon
                  </p>
                </CardContent>
              </Card>
            )}
        </div>
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
                  onClick={handleReset}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={handleSave}
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
