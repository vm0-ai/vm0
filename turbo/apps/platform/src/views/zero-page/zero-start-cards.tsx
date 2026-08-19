import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Play, Sparkles } from "lucide-react";
import type { WorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import { Button } from "@okouai/ui";
import { agentChatComposerSignals$ } from "../../signals/zero-page/agent-composer-signals.ts";
import {
  startCardKinds$,
  startCardWorkflowConnectorIcons$,
  startCardWorkflowTemplate$,
  type StartCardConnectorIcon,
  type StartCardKind,
} from "../../signals/zero-page/zero-start-cards.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";

// Every kind draws into the same square slot so the row reads as one family.
// The card is only ~292px wide, so the tile stays small enough to leave the
// title on one line and the description on two.
const THUMBNAIL_CLASS =
  "grid size-[72px] shrink-0 place-items-center overflow-hidden rounded-xl";

const NODE_CLASS = "rounded-md border border-border bg-card";

/** A resolved connector mark, or `undefined` while the catalog is loading. */
type WorkflowArtIcon = StartCardConnectorIcon | undefined;

function SlidesArt() {
  return (
    <div className="relative h-[31px] w-[42px]">
      <span
        className={`absolute inset-0 -translate-x-[3px] translate-y-[2px] -rotate-6 ${NODE_CLASS}`}
      />
      <span
        className={`absolute inset-0 translate-x-[3px] translate-y-px rotate-6 ${NODE_CLASS}`}
      />
      <span className={`absolute inset-0 ${NODE_CLASS}`}>
        <span className="absolute left-[11px] top-[11px] h-[3px] w-5 rounded-full bg-primary" />
        <span className="absolute left-[11px] top-[17px] h-[3px] w-5 rounded-full bg-muted-foreground/20" />
      </span>
    </div>
  );
}

function WebsiteArt() {
  return (
    <div className="h-[33px] w-[42px] overflow-hidden rounded-md border border-border bg-card">
      <div className="h-[9px] border-b border-border bg-muted" />
      <div className="mx-1 mt-1 h-3 rounded-sm bg-sky-500/25" />
      <div className="mx-1 mt-[3px] h-[3px] w-5 rounded-full bg-muted-foreground/20" />
    </div>
  );
}

function IllustrationArt() {
  return (
    <div className="h-[37px] w-[44px] rounded-md border border-border bg-card p-1">
      <div className="size-[7px] rounded-full bg-amber-400" />
      <div
        className="mt-[3px] h-[19px] rounded-sm bg-emerald-500/40"
        style={{
          clipPath:
            "polygon(0 100%, 0 60%, 27% 26%, 49% 58%, 69% 18%, 100% 62%, 100% 100%)",
        }}
      />
    </div>
  );
}

function VideoArt() {
  return (
    <div className="grid h-[30px] w-[42px] place-items-center rounded-md border border-border bg-card">
      <span className="grid size-4 place-items-center rounded-full bg-primary/15 text-primary">
        <Play size={7} fill="currentColor" />
      </span>
    </div>
  );
}

function AvatarArt() {
  return (
    <div className="flex h-[38px] w-[34px] flex-col items-center justify-end">
      <span className="size-[18px] rounded-full border border-border bg-card" />
      <span className="mt-0.5 h-[15px] w-8 rounded-t-full border border-b-0 border-border bg-card" />
    </div>
  );
}

function WorkflowNode({ icon }: { icon: WorkflowArtIcon }) {
  return (
    <span className={`grid h-[17px] w-[22px] place-items-center ${NODE_CLASS}`}>
      <ConnectorIcon icon={icon?.icon} size={10} />
    </span>
  );
}

/**
 * Flow diagram for the workflow card: the template's first connector is the
 * trigger, the rest are the tools the workflow writes to. Only this card needs
 * connector marks, so the lookups start when it is actually drawn.
 */
function WorkflowArt() {
  const resolved = useLastResolved(startCardWorkflowConnectorIcons$);
  // Hold the diagram shape while the marks are still loading.
  const icons: readonly WorkflowArtIcon[] =
    resolved && resolved.length > 0 ? resolved : [undefined, undefined];
  const [trigger, ...steps] = icons;
  return (
    <div className="flex w-[54px] flex-col items-center">
      <div className="flex h-[17px] w-full items-center gap-1 rounded-md border border-border bg-card px-1">
        <ConnectorIcon icon={trigger?.icon} size={9} />
        <span className="h-[3px] flex-1 rounded-full bg-muted-foreground/20" />
      </div>
      <span className="h-1.5 w-px bg-border" />
      {steps.length > 1 ? (
        <div className="relative flex w-full justify-between">
          <span className="absolute left-[11px] right-[11px] top-0 h-px bg-border" />
          {steps.slice(0, 2).map((icon, index) => {
            return (
              <span key={icon?.slug ?? index} className="relative mt-1.5">
                <span className="absolute -top-1.5 left-1/2 h-1.5 w-px bg-border" />
                <WorkflowNode icon={icon} />
              </span>
            );
          })}
        </div>
      ) : (
        <WorkflowNode icon={steps[0]} />
      )}
    </div>
  );
}

function thumbnailTint(kind: StartCardKind): string {
  switch (kind) {
    case "slides": {
      return "bg-orange-500/10";
    }
    case "website": {
      return "bg-sky-500/10";
    }
    case "illustration": {
      return "bg-emerald-500/10";
    }
    case "video": {
      return "bg-amber-500/10";
    }
    case "avatar": {
      return "bg-violet-500/10";
    }
    case "workflow": {
      return "bg-slate-500/10";
    }
  }
}

interface StartCardContent {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}

/** Shape of `chat.startCards.kinds` in the common namespace. */
type StartCardCopy = Record<
  Exclude<StartCardKind, "workflow">,
  StartCardContent
>;

function StartCard({
  kind,
  content,
  art,
  onSelectPrompt,
  onOpenTemplates,
}: {
  kind: StartCardKind;
  content: StartCardContent;
  art: ReactNode;
  onSelectPrompt: (prompt: string) => void;
  onOpenTemplates: () => void;
}) {
  const { t } = useTranslation();
  // `@container`: the overlay drops its secondary action based on how wide the
  // card actually is, which the viewport alone does not tell us — the same
  // breakpoint yields a 292px card with the sidebar open and a wider one
  // without it.
  return (
    <div className="zero-card group @container relative p-4 transition-colors hover:bg-state-hover">
      {/* Stretched hit area so the whole card opens the template picker, kept as
          a real button so the hover actions stay focusable siblings. */}
      <button
        type="button"
        className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t(($) => {
          return $.chat.startCards.openTemplatesAria;
        })}
        onClick={onOpenTemplates}
      />
      <div className="pointer-events-none flex items-center gap-3">
        <div className={`${THUMBNAIL_CLASS} ${thumbnailTint(kind)}`}>{art}</div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {content.title}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {content.description}
          </p>
        </div>
      </div>
      {/* An overlay rather than a row in the flow: the actions must not reserve
          height while hidden, and `inset-x-4` keeps them inside the card, which
          the two buttons are otherwise too wide for. `bg-inherit` tracks the
          card's own background so the band covers the description line it sits
          on. Hidden actions must not take clicks either — on a touch device
          `hover` never resolves, so a tap here has to reach the card. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex h-8 items-center gap-1.5 bg-inherit opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <Button
          type="button"
          size="sm"
          className="min-w-0"
          onClick={() => {
            onSelectPrompt(content.prompt);
          }}
        >
          <Sparkles />
          <span className="truncate">
            {t(($) => {
              return $.chat.startCards.startWithPrompt;
            })}
          </span>
        </Button>
        {/* Icon-only, and dropped entirely once the card is too narrow to hold
            both actions. The card itself still opens the picker. */}
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="hidden shrink-0 @[16rem]:inline-flex"
          aria-label={t(($) => {
            return $.chat.startCards.templates;
          })}
          onClick={onOpenTemplates}
        >
          <LayoutTemplate />
        </Button>
      </div>
    </div>
  );
}

export function StartCards({
  onSelectPrompt,
}: {
  onSelectPrompt: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const kinds = useGet(startCardKinds$);
  const workflowTemplate = useGet(startCardWorkflowTemplate$);
  const composerSignals = useGet(agentChatComposerSignals$);
  const setTemplateCategory = useSet(
    composerSignals.template.setTemplatePickerCategory$,
  );
  const setTemplateSearch = useSet(
    composerSignals.template.setTemplatePickerSearch$,
  );
  const setTemplatePreviewSlug = useSet(
    composerSignals.template.setTemplatePickerPreviewSlug$,
  );
  const setTemplateReferenceValue = useSet(
    composerSignals.template.setTemplatePickerReferenceValue$,
  );
  const setTemplateOpen = useSet(
    composerSignals.template.setTemplatePickerOpen$,
  );
  const copy: StartCardCopy = t(
    ($) => {
      return $.chat.startCards.kinds;
    },
    { returnObjects: true },
  );

  const openTemplates = (kind: StartCardKind) => {
    setTemplateSearch("");
    setTemplatePreviewSlug(null);
    setTemplateReferenceValue(null);
    setTemplateCategory(kind);
    setTemplateOpen(true);
  };

  const contentFor = (
    kind: StartCardKind,
    template: WorkflowTemplateItem | undefined,
  ): StartCardContent => {
    if (kind === "workflow") {
      return {
        title: template?.title ?? "",
        description: template?.description ?? "",
        prompt: template?.promptGuidance ?? "",
      };
    }
    return copy[kind];
  };

  const artFor = (kind: StartCardKind): ReactNode => {
    const art: Record<StartCardKind, ReactNode> = {
      slides: <SlidesArt />,
      website: <WebsiteArt />,
      illustration: <IllustrationArt />,
      video: <VideoArt />,
      avatar: <AvatarArt />,
      workflow: <WorkflowArt />,
    };
    return art[kind];
  };

  return (
    <div
      data-testid="start-cards"
      className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {kinds.map((kind) => {
        return (
          <StartCard
            key={kind}
            kind={kind}
            content={contentFor(kind, workflowTemplate)}
            art={artFor(kind)}
            onSelectPrompt={onSelectPrompt}
            onOpenTemplates={() => {
              openTemplates(kind);
            }}
          />
        );
      })}
    </div>
  );
}
