import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  FileText,
  Globe,
  Image,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  UserRound,
  Video,
  Workflow,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ComposerPresentationRecommendations } from "./chat-composer.tsx";

const TASK_ICONS = {
  workflow: Workflow,
  presentation: Presentation,
  image: Image,
  video: Video,
} as const;
const IDEA_ICONS = {
  image: [
    Image,
    UserRound,
    CalendarDays,
    Sparkles,
    FileText,
    ChartNoAxesCombined,
  ],
  workflow: [
    UserRound,
    CalendarDays,
    Mail,
    Search,
    ChartNoAxesCombined,
    MessageSquare,
  ],
} as const;
const IDEAS_PER_PAGE = 6;
const IMAGE_IDEAS = [
  "productScene",
  "headshot",
  "eventPoster",
  "businessLogo",
  "newsletterCover",
  "infographic",
  "storePhoto",
  "roomDesign",
  "birthdayInvitation",
  "presentationVisual",
  "profileBanner",
  "cafeMenu",
  "websiteImage",
  "packaging",
  "photoLighting",
  "finishedSketch",
  "greetingCard",
  "brandCharacter",
] as const;
const WORKFLOW_IDEAS = [
  "leadFollowUp",
  "meetingActions",
  "invoices",
  "competitorUpdates",
  "salesSummary",
  "customerFeedback",
  "crmUpdates",
  "meetingPrep",
  "emailDrafts",
  "teamUpdates",
  "businessNews",
  "fileOrganization",
  "projectDelays",
  "socialDrafts",
  "customerReviews",
  "readingDigest",
  "supportThemes",
  "mondayPriorities",
] as const;
const CHIP_CLASS =
  "gap-2 rounded-full border border-transparent px-3 font-normal hover:bg-gray-50";

function ComposerTaskMore({ signals }: { readonly signals: ComposerSignals }) {
  const { t } = useTranslation();
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const selectTask = useSet(signals.taskChips.selectTask$);
  const openCategory = (category: string) => {
    selectTask(null);
    openTemplates({ kind: "insert", category });
  };
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="quiet"
        className={CHIP_CLASS}
        onClick={() => {
          openCategory("website");
        }}
      >
        <Globe size={16} aria-hidden />
        {t(($) => {
          return $.chat.taskChips.website;
        })}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="quiet"
            className={CHIP_CLASS}
          >
            <MoreHorizontal size={16} aria-hidden />
            {t(($) => {
              return $.chat.taskChips.more;
            })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => {
              openCategory("avatar");
            }}
          >
            <UserRound size={16} aria-hidden />
            {t(($) => {
              return $.artifacts.kinds.avatar;
            })}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              openCategory("workflow");
            }}
          >
            <Workflow size={16} aria-hidden />
            {t(($) => {
              return $.chat.taskChips.workflowTemplates;
            })}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              openCategory("slides");
            }}
          >
            <Presentation size={16} aria-hidden />
            {t(($) => {
              return $.chat.startCards.openTemplatesAria;
            })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function ComposerTaskIdeas({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: "image" | "workflow";
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.ideas;
    },
    { returnObjects: true },
  );
  const ideas =
    task === "image"
      ? IMAGE_IDEAS.map((key) => {
          return copy.image[key];
        })
      : WORKFLOW_IDEAS.map((key) => {
          return copy.workflow[key];
        });
  const page = useGet(signals.taskChips.ideaPages$)[task];
  const nextIdeas = useSet(signals.taskChips.nextIdeas$);
  const insertPrompt = useSet(signals.editor.selectOrAppendText$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  const icons = IDEA_ICONS[task];
  return (
    <div
      className="flex flex-col gap-2"
      role="group"
      aria-label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
    >
      <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {ideas
          .slice(page * IDEAS_PER_PAGE, (page + 1) * IDEAS_PER_PAGE)
          .map((idea, index) => {
            const Icon = icons[index % icons.length]!;
            return (
              <Button
                key={idea.label}
                type="button"
                variant="quiet"
                size="sm"
                className="group h-auto min-h-9 min-w-0 justify-start gap-3 px-3 py-2 text-left font-normal hover:bg-gray-50"
                onClick={() => {
                  insertPrompt(idea.prompt);
                  detach(saveDraft(pageSignal), Reason.DomCallback);
                }}
              >
                <Icon
                  size={16}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 whitespace-normal text-[13px] leading-5">
                  {idea.label}
                </span>
                <ArrowUpRight
                  size={14}
                  className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  aria-hidden
                />
              </Button>
            );
          })}
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="gap-2 font-normal hover:bg-gray-50"
          onClick={() => {
            nextIdeas(task, Math.ceil(ideas.length / IDEAS_PER_PAGE));
          }}
        >
          <RefreshCw size={14} aria-hidden />
          {t(($) => {
            return $.chat.taskChips.moreIdeas;
          })}
        </Button>
      </div>
    </div>
  );
}

export function ComposerTaskChips({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selected = useGet(signals.taskChips.task$);
  const selectTask = useSet(signals.taskChips.selectTask$);
  const labels = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const tasks: readonly ComposerTask[] = [
    "workflow",
    "presentation",
    "image",
    "video",
  ];
  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label={t(($) => {
        return $.chat.taskChips.label;
      })}
    >
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t(($) => {
          return $.chat.taskChips.chooseTask;
        })}
      >
        {tasks
          .filter((task) => {
            return task === "workflow" || signals.create.modes.includes(task);
          })
          .map((task) => {
            const Icon = TASK_ICONS[task];
            return (
              <Button
                key={task}
                type="button"
                size="sm"
                variant="quiet"
                aria-pressed={selected === task}
                className={cn(
                  CHIP_CLASS,
                  selected === task &&
                    "border-border bg-gray-50 text-foreground",
                )}
                onClick={() => {
                  selectTask(task);
                }}
              >
                <Icon size={16} aria-hidden />
                {labels[task]}
              </Button>
            );
          })}
        <ComposerTaskMore signals={signals} />
      </div>
      {selected === "presentation" && (
        <ComposerPresentationRecommendations signals={signals} />
      )}
      {(selected === "image" || selected === "workflow") && (
        <ComposerTaskIdeas signals={signals} task={selected} />
      )}
    </section>
  );
}
