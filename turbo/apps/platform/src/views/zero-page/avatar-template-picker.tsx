import {
  IconChevronLeft,
  IconChevronRight,
  IconUser,
} from "@tabler/icons-react";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroAvatarVideoAvatar } from "@vm0/api-contracts/contracts/zero-avatar-video";
import { Button, Skeleton, cn } from "@vm0/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { isSelectedAvatarTemplate } from "../../signals/zero-page/avatar-template-selection.ts";
import type { ComposerSignals } from "../../signals/zero-page/composer-signals.ts";

const AVATAR_CARD_SHADOW =
  "shadow-[0_2px_12px_hsl(220_12%_50%/0.04),0_0_0_0.5px_hsl(220_12%_50%/0.02)]";

function AvatarTemplateCard({
  avatar,
  selected,
  onSelect,
}: {
  readonly avatar: ZeroAvatarVideoAvatar;
  readonly selected: boolean;
  readonly onSelect: (avatar: ZeroAvatarVideoAvatar) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group flex h-64 flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/20",
        AVATAR_CARD_SHADOW,
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <div className="flex h-44 shrink-0 items-center justify-center overflow-hidden bg-muted">
        {avatar.coverUrl ? (
          <img
            src={avatar.coverUrl}
            alt={avatar.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <IconUser
            size={40}
            stroke={1.4}
            className="text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex flex-1 items-center justify-between gap-3 px-3.5 py-3">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">
          {avatar.name}
        </p>
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectTemplate;
            },
            { title: avatar.name },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(avatar);
          }}
          className={cn(
            "h-8 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-background text-foreground hover:bg-muted",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

function AvatarTemplateSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => {
        return <Skeleton key={index} className="h-64 rounded-lg" />;
      })}
    </div>
  );
}

function AvatarTemplateEmpty({ error }: { readonly error: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <p className="text-sm font-semibold text-muted-foreground">
        {error
          ? t(($) => {
              return $.artifacts.catalog.error;
            })
          : t(($) => {
              return $.artifacts.templates.noMatches;
            })}
      </p>
    </div>
  );
}

function AvatarTemplatePagination({
  page,
  hasNext,
  onPrevious,
  onNext,
}: {
  readonly page: number;
  readonly hasNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex items-center justify-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 bg-card"
        aria-label={t(($) => {
          return $.activity.pagination.previous;
        })}
        disabled={page <= 1}
        onClick={onPrevious}
      >
        <IconChevronLeft className="size-4" />
      </Button>
      <span className="min-w-20 text-center text-sm text-muted-foreground">
        {t(
          ($) => {
            return $.activity.pagination.page;
          },
          { current: page },
        )}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 bg-card"
        aria-label={t(($) => {
          return $.activity.pagination.next;
        })}
        disabled={!hasNext}
        onClick={onNext}
      >
        <IconChevronRight className="size-4" />
      </Button>
    </div>
  );
}

export function AvatarTemplatePickerContent({
  signals,
  value,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onSelect: (avatar: ZeroAvatarVideoAvatar) => void;
}) {
  const catalog = useLoadable(signals.template.avatarTemplateCatalogPage$);
  const page = useGet(signals.template.avatarTemplatePage$);
  const goToPrevious = useSet(signals.template.goToPreviousAvatarTemplatePage$);
  const goToNext = useSet(signals.template.goToNextAvatarTemplatePage$);

  if (catalog.state === "loading") {
    return <AvatarTemplateSkeletonGrid />;
  }
  if (catalog.state === "hasError") {
    return <AvatarTemplateEmpty error />;
  }

  return (
    <>
      {catalog.data.avatars.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.data.avatars.map((avatar) => {
            return (
              <AvatarTemplateCard
                key={avatar.id}
                avatar={avatar}
                selected={isSelectedAvatarTemplate(avatar, value)}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      ) : (
        <AvatarTemplateEmpty error={false} />
      )}
      <AvatarTemplatePagination
        page={page}
        hasNext={catalog.data.hasNext}
        onPrevious={goToPrevious}
        onNext={goToNext}
      />
    </>
  );
}
