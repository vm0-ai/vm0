import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  Clapperboard,
  GitBranch,
  Globe,
  Image,
  MoreHorizontal,
  Presentation,
  Sun,
  Mail,
  X,
} from "lucide-react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { FeatureSwitchKey, WORKFLOW_TEMPLATE_ITEMS } from "@okouai/core";
import { IMAGE_MODEL_CONFIGS } from "@okouai/core/image-model-catalog";
import type {
  ComposerSignals,
  ComposerImageModelSignals,
} from "../../signals/okou-page/composer-signals.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task.ts";
import {
  composerTaskEntriesEnabled$,
  featureSwitch$,
} from "../../signals/external/feature-switch.ts";
import { introVideoWizardSignals } from "../../signals/okou-page/intro-video.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { localizedWorkflowTemplate } from "./workflow-template-copy.ts";
import { ComposerInlineVideoOptions } from "./composer-video-options.tsx";

const TASKS = [
  { id: "workflow", icon: GitBranch },
  { id: "slides", icon: Presentation },
  { id: "image", icon: Image },
  { id: "video", icon: Clapperboard },
  { id: "website", icon: Globe },
] as const satisfies readonly { id: ComposerTask; icon: typeof GitBranch }[];

const WORKFLOW_STARTERS = [
  { id: "workflow-template:morning-brief", icon: Sun },
  { id: "workflow-template:sort-gmail-draft-replies", icon: Mail },
  { id: "workflow-template:research-calendar-meetings", icon: CalendarDays },
] as const;

function MoreTasks({ signals }: { readonly signals: ComposerSignals }) {
  const { t } = useTranslation();
  const flags = useLastResolved(featureSwitch$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const openIntro = useSet(introVideoWizardSignals.openWizard$);
  const pageSignal = useGet(pageSignal$);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="quiet" size="sm">
          <MoreHorizontal />
          {t(($) => {
            return $.chat.taskEntries.more;
          })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            openTemplates({ kind: "insert", category: "avatar" });
          }}
        >
          {t(($) => {
            return $.chat.taskEntries.avatar;
          })}
        </DropdownMenuItem>
        {flags?.[FeatureSwitchKey.IntroVideo] && (
          <DropdownMenuItem
            onSelect={() => {
              detach(openIntro(pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.taskEntries.introVideo;
            })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ComposerTaskEntries({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selected = useGet(signals.task.task$);
  const selectTask = useSet(signals.task.selectTask$);
  const labels = t(
    ($) => {
      return $.chat.taskEntries.labels;
    },
    { returnObjects: true },
  );
  return (
    <div className="flex flex-col gap-6" data-testid="composer-task-entries">
      <div
        className="flex flex-wrap items-center justify-center gap-1 sm:gap-2"
        role="group"
        aria-label={t(($) => {
          return $.chat.taskEntries.chooseTask;
        })}
      >
        {TASKS.map(({ id, icon: Icon }) => {
          return (
            <Button
              key={id}
              variant={id === "workflow" ? "ghost" : "quiet"}
              size="sm"
              aria-pressed={selected === id}
              className={cn(
                "gap-2",
                id === "workflow" && "bg-brand-subtle/50",
                selected === id &&
                  "bg-brand-subtle text-brand-text hover:bg-brand-subtle/70",
              )}
              onClick={() => {
                selectTask(selected === id ? null : id);
              }}
            >
              <Icon />
              {labels[id]}
            </Button>
          );
        })}
        <MoreTasks signals={signals} />
      </div>
      <WorkflowStarters signals={signals} />
    </div>
  );
}

function WorkflowStarters({ signals }: { readonly signals: ComposerSignals }) {
  const { t } = useTranslation();
  const selectTask = useSet(signals.task.selectTask$);
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  return (
    <section
      className="rounded-[var(--okou-card-radius)] bg-gray-50 p-4 sm:p-5"
      aria-label={t(($) => {
        return $.chat.taskEntries.workflowHeading;
      })}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <GitBranch className="size-4 shrink-0 text-brand-text" aria-hidden />
          <h3 className="text-sm font-medium">
            {t(($) => {
              return $.chat.taskEntries.workflowHeading;
            })}
          </h3>
        </div>
        <Button
          variant="quiet"
          size="sm"
          className="shrink-0"
          onClick={() => {
            openTemplates({ kind: "insert", category: "workflow" });
          }}
        >
          {t(($) => {
            return $.chat.taskEntries.browseWorkflows;
          })}
          <ArrowUpRight />
        </Button>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {t(($) => {
          return $.chat.taskEntries.workflowDescription;
        })}
      </p>
      <div className="mt-4 grid gap-1 sm:grid-cols-3 sm:gap-3">
        {WORKFLOW_STARTERS.map(({ id, icon: Icon }) => {
          const template = WORKFLOW_TEMPLATE_ITEMS.find((item) => {
            return item.id === id;
          });
          if (!template) {
            return null;
          }
          const localized = localizedWorkflowTemplate(template);
          return (
            <Button
              key={id}
              aria-label={localized.title}
              variant="quiet"
              className="h-auto min-h-16 justify-start gap-3 whitespace-normal p-3 text-left hover:bg-background"
              onClick={() => {
                selectTask("workflow");
                insertTemplate(
                  {
                    type: "workflow",
                    selection: { workflowTemplateId: template.id },
                  },
                  {
                    type: "workflow",
                    title: localized.title,
                    category: "workflow",
                  },
                );
              }}
            >
              <Icon className="text-brand-text" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">
                  {localized.title}
                </span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {localized.shortDescription}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

export function ComposerTaskHeader({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const task = useGet(signals.task.task$);
  const selectTask = useSet(signals.task.selectTask$);
  const labels = t(
    ($) => {
      return $.chat.taskEntries.labels;
    },
    { returnObjects: true },
  );
  const hints = t(
    ($) => {
      return $.chat.taskEntries.hints;
    },
    { returnObjects: true },
  );
  if (task === null) {
    return null;
  }
  const Icon =
    TASKS.find((item) => {
      return item.id === task;
    })?.icon ?? GitBranch;
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />
        <div>
          <span className="text-sm font-medium text-brand-text">
            {labels[task]}
          </span>
          <p className="mt-1 text-xs text-muted-foreground">{hints[task]}</p>
        </div>
      </div>
      <Button
        variant="quiet"
        size="icon-sm"
        aria-label={t(($) => {
          return $.chat.taskEntries.clearTask;
        })}
        onClick={() => {
          selectTask(null);
        }}
      >
        <X />
      </Button>
    </div>
  );
}

function ImageTaskModel({
  signals,
  imageModel,
}: {
  readonly signals: ComposerSignals;
  readonly imageModel: ComposerImageModelSignals;
}) {
  const model = useLastResolved(imageModel.effectiveImageModel$);
  const setCategory = useSet(signals.model.setMediaModelCategory$);
  const setOpen = useSet(signals.model.setModelPickerOpen$);
  if (model === undefined) {
    return null;
  }
  return (
    <Button
      variant="quiet"
      size="sm"
      onClick={() => {
        setCategory("image");
        setOpen(true);
      }}
    >
      <Image />
      {IMAGE_MODEL_CONFIGS[model].label}
      <ChevronDown />
    </Button>
  );
}

export function ComposerTaskOptions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const task = useGet(signals.task.task$);
  const enabled = useGet(composerTaskEntriesEnabled$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  if (!enabled || task === null) {
    return null;
  }
  return (
    <div className="mx-4 mb-3 border-t border-border/60 pt-3">
      {task === "video" && signals.videoModel && (
        <ComposerInlineVideoOptions
          signals={signals}
          videoModelSignals={signals.videoModel}
        />
      )}
      <div className="flex flex-wrap items-center gap-1">
        {task === "image" && signals.imageModel && (
          <ImageTaskModel signals={signals} imageModel={signals.imageModel} />
        )}
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            openTemplates({
              kind: "insert",
              category: task === "image" ? "illustration" : task,
            });
          }}
        >
          <Presentation />
          {t(($) => {
            return $.chat.taskEntries.chooseTemplate;
          })}
          <ArrowUpRight />
        </Button>
      </div>
    </div>
  );
}
