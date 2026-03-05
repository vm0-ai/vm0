import { useState } from "react";
import {
  IconMessageCircle,
  IconUser,
  IconFileText,
  IconPlug,
  IconX,
  IconPlus,
  IconTool,
} from "@tabler/icons-react";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons";
import {
  Card,
  CardContent,
  Input,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";

const TONE_OPTIONS = [
  "Professional",
  "Friendly",
  "Direct",
  "Supportive",
] as const;

const TONE_HINT: Record<(typeof TONE_OPTIONS)[number], string> = {
  Professional: "Clear and polished",
  Friendly: "Warm and approachable",
  Direct: "To the point",
  Supportive: "In your corner",
};

const TONE_SAMPLES: Record<
  (typeof TONE_OPTIONS)[number],
  { user: string; zero: string }
> = {
  Professional: {
    user: "I need the Q3 report by Friday.",
    zero: "I’ll have the Q3 report ready by Friday. I’ll send a draft by Thursday for your review.",
  },
  Friendly: {
    user: "I need the Q3 report by Friday.",
    zero: "Sure thing! I’ll get that Q3 report to you by Friday—I’ll send over a draft Thursday so you can take a look.",
  },
  Direct: {
    user: "I need the Q3 report by Friday.",
    zero: "Friday. I’ll send a draft Thursday.",
  },
  Supportive: {
    user: "I need the Q3 report by Friday.",
    zero: "I’ll make sure you have the Q3 report by Friday. I’ll send a draft on Thursday so you have time to review—let me know if you’d like anything else.",
  },
};

const AVAILABLE_SKILLS = [
  "github",
  "linear",
  "plausible",
  "agentmail",
  "axiom",
  "notion",
  "vm0-cli",
  "vm0-agent",
  "slack",
  "gmail",
  "elephant",
];

const CONNECTOR_LIST: ConnectorType[] = [
  "github",
  "linear",
  "notion",
  "gmail",
  "slack",
];

export function ZeroMeetPage() {
  const [activeTab, setActiveTab] = useState("settings");
  const [agentName, setAgentName] = useState("Zero");
  const [roleExpertise, setRoleExpertise] = useState("AI Assistant");
  const [tone, setTone] = useState<string>("Professional");
  const [skills, setSkills] = useState<string[]>([...AVAILABLE_SKILLS]);
  const ADD_SKILL_PLACEHOLDER = "__add_skill__";
  const [addSkillValue, setAddSkillValue] = useState(ADD_SKILL_PLACEHOLDER);

  const removeSkill = (skill: string) => {
    setSkills((prev) => prev.filter((s) => s !== skill));
  };

  const addSkill = (skill: string) => {
    if (!skills.includes(skill)) {
      setSkills((prev) => [...prev, skill].sort());
    }
    setAddSkillValue(ADD_SKILL_PLACEHOLDER);
  };

  const availableToAdd = AVAILABLE_SKILLS.filter((s) => !skills.includes(s));

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px] px-7">
          <div className="flex items-center gap-4">
            <img
              src="/zero-avatar.png"
              alt=""
              role="presentation"
              className="h-14 w-14 shrink-0 rounded-full object-cover object-top sm:h-16 sm:w-16"
            />
            <div className="min-w-0 pt-2 sm:pt-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-foreground leading-tight">
                Zero
              </h1>
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
              <TabsList className="h-9 w-full sm:w-auto gap-1 bg-muted/60 px-1 py-1">
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
                <TabsTrigger
                  value="connections"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconPlug size={14} stroke={1.5} />
                  Connections
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-2 rounded-lg px-4"
            >
              <IconMessageCircle size={14} stroke={1.5} />
              Just ask
            </Button>
          </div>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        {activeTab === "settings" && (
          <div className="mx-auto max-w-[900px] px-7">
            <Card className="rounded-2xl border border-border/70 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
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
                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor="zero-role"
                      className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      Role
                    </label>
                    <Input
                      id="zero-role"
                      value={roleExpertise}
                      onChange={(e) => setRoleExpertise(e.target.value)}
                      placeholder="e.g. AI assistant, project buddy"
                      className="h-9"
                    />
                  </div>
                  <div
                    className="flex flex-col gap-2"
                    role="group"
                    aria-label="How Zero sounds"
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
                            "rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            tone === opt
                              ? "border border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                              : "border border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground dark:bg-muted/20 dark:hover:bg-muted/30",
                          )}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                    <div
                      className="rounded-lg border border-border/40 bg-muted/30 px-3 py-2 transition-colors duration-200 dark:bg-muted/20"
                      key={tone}
                    >
                      <p className="text-xs text-muted-foreground italic min-h-[1.25rem] leading-relaxed">
                        {TONE_HINT[tone as (typeof TONE_OPTIONS)[number]]}
                      </p>
                      <div className="my-2 border-t border-border/30" />
                      <div className="flex flex-col gap-1.5 pb-1.5">
                        <div className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl px-3 py-2 bg-stone-200/90 text-stone-800 text-sm leading-relaxed transition-colors duration-200 dark:bg-stone-600/90 dark:text-stone-100">
                            {
                              TONE_SAMPLES[
                                tone as (typeof TONE_OPTIONS)[number]
                              ].user
                            }
                          </div>
                        </div>
                        <div className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl border border-border/40 bg-card/98 px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200">
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
                  <div className="flex flex-col gap-3">
                    <div>
                      <span className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Tools & skills
                      </span>
                    </div>
                    <ul className="flex flex-wrap gap-2" role="list">
                      {skills.map((skill) => (
                        <li
                          key={skill}
                          className="flex min-w-[120px] max-w-[220px] flex-1 basis-[120px]"
                        >
                          <span className="flex w-full min-w-0 items-center gap-2 rounded-2xl border border-border/80 bg-muted/50 px-3 py-2.5 text-sm text-foreground transition-colors duration-200 hover:bg-muted hover:border-border">
                            {CONNECTOR_LIST.includes(skill as ConnectorType) ? (
                              <ConnectorIcon
                                type={skill as ConnectorType}
                                size={16}
                              />
                            ) : (
                              <IconTool
                                size={16}
                                stroke={1.5}
                                className="shrink-0 text-muted-foreground"
                              />
                            )}
                            <span className="min-w-0 truncate font-medium capitalize">
                              {skill.charAt(0).toUpperCase() +
                                skill.slice(1).toLowerCase()}
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
                      ))}
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
                          <SelectTrigger className="h-10 min-w-[120px] gap-2 rounded-2xl border border-border/80 bg-muted/50 px-3 py-2.5 text-sm text-foreground hover:bg-muted hover:border-border transition-colors duration-200">
                            <IconPlus size={14} stroke={2} />
                            <SelectValue placeholder="Add skill" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ADD_SKILL_PLACEHOLDER}>
                              Add skill
                            </SelectItem>
                            {availableToAdd.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "instructions" && (
          <div className="mx-auto max-w-[900px] px-7">
            <Card className="rounded-2xl border border-border bg-gradient-to-br from-stone-100/95 via-stone-50 to-stone-100/90 shadow-[0_1px_3px_rgba(0,0,0,0.06)] dark:from-stone-800/95 dark:via-stone-800/90 dark:to-stone-900/95 dark:border-border/80">
              <CardContent className="py-7">
                <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 sm:items-end">
                  <div className="space-y-5 text-sm text-foreground leading-relaxed flex-1 min-w-0">
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Role & Expertise
                      </h2>
                      <p>
                        Zero is an intelligent AI assistant designed to help
                        teams with automation, data analysis, and workflow
                        orchestration.
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
                  <div className="shrink-0 flex justify-center sm:justify-end sm:items-end">
                    <img
                      src="/instructions-illustration.png"
                      alt=""
                      role="presentation"
                      className="h-48 w-auto max-w-[220px] rounded-xl object-cover"
                    />
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

        {activeTab === "connections" && (
          <div className="mx-auto max-w-[900px] px-7 flex flex-col gap-6">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <h2 className="text-base font-semibold tracking-tight text-foreground">
                  Connectors
                </h2>
                <p className="text-sm text-muted-foreground">
                  Connect and authorize these services so your agent can act on
                  your behalf.
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
                return (
                  <li key={type}>
                    <Card className="rounded-xl border border-border/70 bg-card">
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
                          variant="outline"
                          className="h-8 shrink-0 rounded-lg px-3"
                        >
                          Connect
                        </Button>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
