import { useState } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowLeft,
  IconFileText,
  IconSettings,
  IconPlug,
  IconSparkles,
  IconX,
  IconPlus,
  IconTool,
  IconCalendar,
  IconPencil,
} from "@tabler/icons-react";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Card,
  CardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons";
import { ZeroScheduleCard, DUMMY_AGENT_SCHEDULE } from "./zero-schedule-card";

export interface JobItem {
  id: string;
  agentName: string;
  title: string;
  description: string;
  scope: "personal" | "team";
}

const WORKFLOW_SKILLS_OPTIONS = [
  "Slack",
  "Notion",
  "GitHub",
  "Gmail",
  "Data Analysis",
  "Content Summarization",
  "Linear",
];

const INITIAL_SKILLS = [
  "Slack",
  "Data Analysis",
  "Content Summarization",
] as const;

const CONNECTOR_LIST: ConnectorType[] = [
  "github",
  "linear",
  "notion",
  "gmail",
  "slack",
];

function skillToConnectorType(skill: string): ConnectorType | null {
  const lower = skill.toLowerCase();
  return CONNECTOR_LIST.includes(lower as ConnectorType)
    ? (lower as ConnectorType)
    : null;
}

interface ZeroJobDetailPageProps {
  job: JobItem;
  onBack: () => void;
}

export function ZeroJobDetailPage({ job, onBack }: ZeroJobDetailPageProps) {
  const [activeTab, setActiveTab] = useState("connectors");
  const [settingsName, setSettingsName] = useState(job.title);
  const [settingsDescription, setSettingsDescription] = useState(
    job.description,
  );
  const [skills, setSkills] = useState<string[]>([...INITIAL_SKILLS]);
  const ADD_SKILL_PLACEHOLDER = "__add_skill__";
  const [addSkillValue, setAddSkillValue] = useState(ADD_SKILL_PLACEHOLDER);
  const [connectedConnectors, setConnectedConnectors] = useState<
    ConnectorType[]
  >(["github", "slack"]);

  const removeSkill = (s: string) =>
    setSkills((prev) => prev.filter((x) => x !== s));
  const toggleConnector = (type: ConnectorType) => {
    setConnectedConnectors((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };
  const addSkill = (s: string) => {
    if (!skills.includes(s)) {
      setSkills((prev) => [...prev, s].sort());
    }
    setAddSkillValue(ADD_SKILL_PLACEHOLDER);
  };
  const availableSkills = WORKFLOW_SKILLS_OPTIONS.filter(
    (s) => !skills.includes(s),
  );

  const [savedSettings, setSavedSettings] = useState<{
    name: string;
    description: string;
    skills: string[];
  }>({
    name: job.title,
    description: job.description,
    skills: [...INITIAL_SKILLS],
  });

  const isSettingsDirty =
    settingsName !== savedSettings.name ||
    settingsDescription !== savedSettings.description ||
    JSON.stringify([...skills].sort()) !==
      JSON.stringify([...savedSettings.skills].sort());
  const showSaveBar = isSettingsDirty;

  const handleReset = () => {
    setSettingsName(savedSettings.name);
    setSettingsDescription(savedSettings.description);
    setSkills([...savedSettings.skills]);
  };

  const handleSave = () => {
    setSavedSettings({
      name: settingsName,
      description: settingsDescription,
      skills: [...skills],
    });
    // API persist would go here
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
                Connectors
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
                  <div className="shrink-0 flex justify-center sm:justify-end sm:items-end">
                    <img
                      src="/instructions-illustration.png"
                      alt=""
                      role="presentation"
                      className="h-48 w-auto max-w-[220px] rounded-xl object-contain"
                    />
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
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Skills
                  </span>
                  <ul className="flex flex-wrap gap-2" role="list">
                    {skills.map((skill) => {
                      const connectorType = skillToConnectorType(skill);
                      return (
                        <li
                          key={skill}
                          className="flex min-w-[120px] max-w-[220px] flex-1 basis-[120px]"
                        >
                          <span className="zero-chip flex w-full min-w-0 items-center gap-2 rounded-2xl border px-3 py-2.5 text-sm text-foreground transition-colors duration-200">
                            {connectorType ? (
                              <ConnectorIcon type={connectorType} size={16} />
                            ) : (
                              <IconTool
                                size={16}
                                stroke={1.5}
                                className="shrink-0 text-muted-foreground"
                              />
                            )}
                            <span className="min-w-0 truncate font-medium">
                              {skill}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeSkill(skill)}
                              className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              aria-label={`Remove ${skill}`}
                            >
                              <IconX size={12} stroke={2} />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                    {availableSkills.length > 0 && (
                      <li className="flex shrink-0">
                        <Select
                          value={addSkillValue}
                          onValueChange={(v) => {
                            setAddSkillValue(ADD_SKILL_PLACEHOLDER);
                            if (v && v !== ADD_SKILL_PLACEHOLDER) {
                              addSkill(v);
                            }
                          }}
                        >
                          <SelectTrigger className="zero-chip h-10 min-w-[120px] gap-2 rounded-2xl border px-3 py-2.5 text-sm text-foreground transition-colors duration-200">
                            <IconPlus size={14} stroke={2} />
                            <SelectValue placeholder="Add skill" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ADD_SKILL_PLACEHOLDER}>
                              Add skill
                            </SelectItem>
                            {availableSkills.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    )}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "connectors" && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    Connectors
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Third-party services this workflow can use
                  </p>
                </div>
                <Button size="sm" className="h-9 shrink-0 gap-2 rounded-lg">
                  <IconPlus size={16} stroke={2} />
                  Add Connector
                </Button>
              </div>
              <ul className="flex flex-col gap-3">
                {CONNECTOR_LIST.map((type) => {
                  const config = CONNECTOR_TYPES[type];
                  const connected = connectedConnectors.includes(type);
                  return (
                    <li key={type}>
                      <Card className="zero-card">
                        <CardContent className="flex items-center gap-4 px-4 py-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted overflow-hidden">
                            <ConnectorIcon type={type} size={24} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-foreground">
                              {config.label}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {config.helpText}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={connected ? "secondary" : "outline"}
                            className={cn(
                              "h-8 shrink-0 rounded-lg px-3",
                              !connected && "zero-btn-morandi border",
                            )}
                            onClick={() => toggleConnector(type)}
                          >
                            {connected ? "Connected" : "Connect"}
                          </Button>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

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
