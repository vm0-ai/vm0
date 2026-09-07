import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Lock, Plus } from "lucide-react";
import { Button } from "@okouai/ui";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task.ts";
import { orgPlanCapabilities$ } from "../../signals/okou-page/org-plan-capabilities.ts";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

type TemplateTask = Exclude<ComposerTask, "workflow">;

interface TaskTemplate {
  readonly title: string;
  readonly image: string;
  readonly request: Extract<
    GenerationTemplateRequest,
    { type: "presentation" | "illustration" | "video" | "website" }
  >;
}

// Use the same catalog entries, preview assets, and defaults as the library.
const TASK_TEMPLATES: Readonly<Record<TemplateTask, readonly TaskTemplate[]>> =
  {
    slides: PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(0, 3).map(
      (item): TaskTemplate => {
        return {
          title: item.title,
          image: item.cardPreviewImage ?? item.previewImage,
          request: {
            type: "presentation",
            selection: {
              templateId: item.templateId,
              colorSystemId: item.colorSystemId ?? "color-system:warm-sand",
              previewUrl: item.embedUrl,
            },
          },
        };
      },
    ),
    image: ILLUSTRATION_TEMPLATE_ITEMS.slice(0, 3).map((item): TaskTemplate => {
      return {
        title: item.title,
        image: item.cardPreviewImage ?? item.previewImage,
        request: {
          type: "illustration",
          selection: { illustrationStyleId: item.illustrationStyleId },
        },
      };
    }),
    video: VIDEO_TEMPLATE_ITEMS.slice(0, 3).map((item): TaskTemplate => {
      return {
        title: item.title,
        image: item.cardPreviewImage ?? item.previewImage,
        request: { type: "video", selection: { stylePresetId: item.id } },
      };
    }),
    website: WEBSITE_TEMPLATE_ITEMS.slice(0, 3).map((item): TaskTemplate => {
      return {
        title: item.title,
        image: item.previewImageUrl,
        request: {
          type: "website",
          selection: { websiteTemplateId: item.id },
        },
      };
    }),
  };

function TaskTemplateCard({
  item,
  requiresPro,
  onSelect,
}: {
  readonly item: TaskTemplate;
  readonly requiresPro: boolean;
  readonly onSelect: (item: TaskTemplate) => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="quiet"
      aria-label={
        requiresPro
          ? t(
              ($) => {
                return $.artifacts.templates.viewVideoPlans;
              },
              { title: item.title },
            )
          : t(
              ($) => {
                return $.chat.taskEntries.useTemplate;
              },
              { title: item.title },
            )
      }
      className="group h-auto w-full justify-start gap-3 whitespace-normal rounded-xl bg-background p-2.5 text-left hover:bg-state-hover sm:flex-col sm:items-stretch"
      onClick={() => {
        onSelect(item);
      }}
    >
      <span className="w-24 shrink-0 overflow-hidden rounded-lg bg-gray-50 sm:w-full">
        <img
          src={item.image}
          alt=""
          loading="lazy"
          decoding="async"
          className="aspect-video w-full object-cover transition-opacity group-hover:opacity-90"
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center justify-between gap-2 text-[13px] text-foreground sm:px-1 sm:pb-1">
        <span>{item.title}</span>
        {requiresPro ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
            <Lock aria-hidden />
            {t(($) => {
              return $.artifacts.templates.needPro;
            })}
          </span>
        ) : (
          <Plus className="text-muted-foreground" aria-hidden />
        )}
      </span>
    </Button>
  );
}

export function ComposerTaskTemplates({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: TemplateTask;
}) {
  const { t } = useTranslation();
  const headings = t(
    ($) => {
      return $.chat.taskEntries.templateHeadings;
    },
    { returnObjects: true },
  );
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const plan = useLastResolved(orgPlanCapabilities$);
  const pageSignal = useGet(pageSignal$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const requiresPro =
    task === "video" && plan?.videoGenerationAllowed === false;
  const category = task === "image" ? "illustration" : task;
  const selectTemplate = (item: TaskTemplate) => {
    if (requiresPro) {
      openBillingPlans();
      detach(openSettings(true, pageSignal), Reason.DomCallback);
      return;
    }
    insertTemplate(item.request, {
      type: item.request.type,
      title: item.title,
      category,
    });
  };
  return (
    <section
      className="rounded-[var(--okou-card-radius)] bg-gray-50 p-4 sm:p-5"
      aria-label={headings[task]}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{headings[task]}</h3>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            openTemplates({ kind: "insert", category });
          }}
        >
          {t(($) => {
            return $.chat.taskEntries.browseTemplates;
          })}
          <ArrowUpRight />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
        {TASK_TEMPLATES[task].map((item) => {
          return (
            <TaskTemplateCard
              key={item.title}
              item={item}
              requiresPro={requiresPro}
              onSelect={selectTemplate}
            />
          );
        })}
      </div>
    </section>
  );
}
