import type { KeyboardEvent, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cpu,
  SlidersHorizontal,
} from "lucide-react";
import { Button, Switch, cn } from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { useTranslation } from "react-i18next";
import type { ModelPickerMenuSignals } from "../../../signals/okou-page/model-picker-menu.ts";
import { PriceTierBadge } from "./model-picker-price-tier.tsx";
import {
  getMediaModelPriceTierLabel,
  getModelBrandIconType,
} from "./settings/provider-ui-config.ts";
import { ProviderIcon } from "./settings/provider-icons.tsx";
import type {
  MediaModelPanelState,
  ModelProviderSelection,
} from "./model-provider-picker.tsx";

interface ModelPickerMenuOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled: boolean;
  readonly fastAvailable: boolean;
}

function MenuHeader({
  label,
  onBack,
  backLabel,
}: {
  label: string;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex h-7 items-center gap-1 bg-card px-2 text-xs text-muted-foreground">
      {onBack && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-1 h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={backLabel}
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </Button>
      )}
      <span>{label}</span>
    </div>
  );
}

function CurrentModelRow({
  model,
  category,
  icon,
  summary,
  onChange,
  onSettings,
}: {
  model: string;
  category: string;
  icon: ReactNode;
  summary?: string;
  onChange: () => void;
  onSettings?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative h-12 rounded-lg">
      <Button
        variant="ghost"
        className={cn(
          "h-full w-full justify-start gap-2 px-2 pr-7 text-left font-normal text-foreground",
          onSettings && "pr-16",
        )}
        aria-label={t(
          ($) => {
            return $.settings.models.picker.menu.changeModel;
          },
          { category, model },
        )}
        onClick={onChange}
      >
        <span className="flex w-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-[13px] leading-[19px]">{model}</span>
          <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
            {category}
            {summary && <> · {summary}</>}
          </span>
        </span>
        <ChevronRight
          size={13}
          aria-hidden="true"
          className="absolute right-2 text-muted-foreground"
        />
      </Button>
      {onSettings && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-7 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={t(
            ($) => {
              return $.settings.models.picker.menu.adjustSettings;
            },
            { model },
          )}
          onClick={onSettings}
        >
          <SlidersHorizontal size={15} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/** Keep arrow navigation in the same order as the menu's tabbable controls. */
function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [role="switch"]:not([data-disabled])',
    ),
  );
  const current = controls.findIndex((button) => {
    return button === event.target;
  });
  if (controls.length === 0 || current === -1) {
    return;
  }
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) %
          controls.length;
  controls[next]?.focus();
}

interface ModelPickerMenuContentProps {
  signals: ModelPickerMenuSignals;
  value: ModelProviderSelection | null;
  placeholder: string;
  options: readonly ModelPickerMenuOption[];
  mediaModelPanel: MediaModelPanelState | undefined;
  onChange: (selection: ModelProviderSelection) => void;
}

function ModelPickerOverview({
  signals,
  value,
  placeholder,
  options,
  mediaModelPanel,
}: Omit<ModelPickerMenuContentProps, "onChange">) {
  const { t } = useTranslation();
  const showModels = useSet(signals.showModels$);
  const editSettings = useSet(signals.editSettings$);
  const selectedOption = options.find((option) => {
    return option.model === value?.selectedModel;
  });
  const chatLabel =
    selectedOption?.label ??
    (value ? getCanonicalModelDisplayName(value.selectedModel) : placeholder);
  const chatIconType = value
    ? getModelBrandIconType(value.selectedModel)
    : undefined;
  const speedLabel =
    value?.codexServiceTier === "fast"
      ? t(($) => {
          return $.settings.models.picker.fast;
        })
      : t(($) => {
          return $.settings.models.picker.standard;
        });
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.models;
        })}
      />
      <div className="flex flex-col gap-0.5">
        <CurrentModelRow
          model={chatLabel}
          category={t(($) => {
            return $.settings.models.picker.categoryChat;
          })}
          icon={
            chatIconType ? (
              <ProviderIcon type={chatIconType} size={17} />
            ) : (
              <Cpu size={17} />
            )
          }
          summary={selectedOption?.fastAvailable ? speedLabel : undefined}
          onChange={() => {
            mediaModelPanel?.onActiveCategoryChange(null);
            showModels("chat");
          }}
          onSettings={
            selectedOption?.fastAvailable && value
              ? () => {
                  mediaModelPanel?.onActiveCategoryChange(null);
                  editSettings(value, "overview");
                }
              : undefined
          }
        />
        {mediaModelPanel?.categories.map((category) => {
          const selected = category.options.find((option) => {
            return option.selected;
          });
          return (
            <CurrentModelRow
              key={category.id}
              model={selected?.label ?? category.label}
              category={category.tabLabel}
              icon={selected?.icon}
              onChange={() => {
                mediaModelPanel.onActiveCategoryChange(category.id);
                showModels(category.id);
              }}
            />
          );
        })}
      </div>
    </>
  );
}

function ChatModelSettings({
  signals,
  options,
  selection,
  from,
  onChange,
}: Pick<ModelPickerMenuContentProps, "signals" | "options" | "onChange"> & {
  selection: ModelProviderSelection;
  from: "overview" | "models";
}) {
  const { t } = useTranslation();
  const reset = useSet(signals.reset$);
  const back = useSet(signals.back$);
  const setFast = useSet(signals.setFast$);
  const option = options.find((candidate) => {
    return candidate.model === selection.selectedModel;
  });
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.menu.chatSettings;
        })}
        onBack={back}
        backLabel={
          from === "models"
            ? t(($) => {
                return $.settings.models.picker.menu.backToChatModels;
              })
            : t(($) => {
                return $.settings.models.picker.menu.backToModels;
              })
        }
      />
      <div className="border-b border-border/60 px-2 py-2.5 text-sm">
        {option?.content ??
          getCanonicalModelDisplayName(selection.selectedModel)}
      </div>
      <div className="flex items-center justify-between gap-3 px-2 py-4">
        <div>
          <span className="text-[13px]">
            {t(($) => {
              return $.settings.models.picker.fast;
            })}
          </span>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.fastImpact;
            })}
          </p>
        </div>
        <Switch
          size="compact"
          aria-label={t(($) => {
            return $.settings.models.picker.fast;
          })}
          checked={selection.codexServiceTier === "fast"}
          onCheckedChange={setFast}
          disabled={!option?.fastAvailable}
        />
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-2 pb-1.5 pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={reset}
        >
          {t(($) => {
            return $.settings.models.picker.menu.cancel;
          })}
        </Button>
        <Button
          size="sm"
          disabled={!option?.fastAvailable || option.disabled}
          onClick={() => {
            onChange(selection);
            reset();
          }}
        >
          {t(($) => {
            return $.settings.models.picker.menu.confirm;
          })}
        </Button>
      </div>
    </>
  );
}

function ChatModelList({
  signals,
  options,
  value,
  onChange,
}: Pick<
  ModelPickerMenuContentProps,
  "signals" | "options" | "value" | "onChange"
>) {
  const { t } = useTranslation();
  const back = useSet(signals.back$);
  const reset = useSet(signals.reset$);
  const editSettings = useSet(signals.editSettings$);
  const chooseChat = (option: ModelPickerMenuOption) => {
    if (option.fastAvailable) {
      editSettings(
        value?.selectedModel === option.model
          ? value
          : { selectedModel: option.model },
        "models",
      );
    } else {
      onChange({ selectedModel: option.model });
      reset();
    }
  };
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.chatModels;
        })}
        onBack={back}
        backLabel={t(($) => {
          return $.settings.models.picker.menu.backToModels;
        })}
      />
      <div className="flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1">
        {options.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.noConfiguredModels;
            })}
          </p>
        )}
        {options.map((option) => {
          return (
            <Button
              key={option.model}
              variant="ghost"
              className="relative h-9 w-full justify-start px-2 pr-8 text-left font-normal text-foreground"
              aria-label={option.label}
              aria-pressed={value?.selectedModel === option.model}
              disabled={option.disabled}
              onClick={() => {
                chooseChat(option);
              }}
            >
              {option.content}
              {value?.selectedModel === option.model && (
                <Check
                  size={15}
                  aria-hidden="true"
                  className="absolute right-2"
                />
              )}
            </Button>
          );
        })}
      </div>
    </>
  );
}

function MediaModelList({
  signals,
  mediaModelPanel,
  categoryId,
}: Pick<ModelPickerMenuContentProps, "signals" | "mediaModelPanel"> & {
  categoryId: "image" | "video";
}) {
  const { t } = useTranslation();
  const back = useSet(signals.back$);
  const reset = useSet(signals.reset$);
  const category = mediaModelPanel?.categories.find((candidate) => {
    return candidate.id === categoryId;
  });
  return (
    <>
      <MenuHeader
        label={
          category?.label ??
          t(($) => {
            return $.settings.models.picker.models;
          })
        }
        onBack={back}
        backLabel={t(($) => {
          return $.settings.models.picker.menu.backToModels;
        })}
      />
      <div className="flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1">
        {category?.options.map((option) => {
          return (
            <Button
              key={option.key}
              variant="ghost"
              className="relative h-9 w-full justify-start gap-2 px-2 pr-8 text-left font-normal text-foreground"
              aria-label={option.label}
              aria-pressed={option.selected}
              aria-current={option.selected ? "true" : undefined}
              onClick={() => {
                option.onSelect();
                reset();
              }}
            >
              {option.icon}
              <span className="min-w-0 truncate">{option.label}</span>
              <PriceTierBadge
                tier={option.priceTier}
                description={getMediaModelPriceTierLabel(option.priceTier)}
              />
              {option.selected && (
                <Check
                  size={15}
                  aria-hidden="true"
                  className="absolute right-2"
                />
              )}
            </Button>
          );
        })}
      </div>
    </>
  );
}

export function ModelPickerMenuContent(props: ModelPickerMenuContentProps) {
  const { t } = useTranslation();
  const page = useGet(props.signals.page$);
  const back = useSet(props.signals.back$);
  const focusPanel = useSet(props.signals.focusPanelRef$);
  let content: ReactNode;
  let label: string;
  if (page.kind === "overview") {
    label = t(($) => {
      return $.settings.models.picker.models;
    });
    content = <ModelPickerOverview {...props} />;
  } else if (page.kind === "settings") {
    label = t(($) => {
      return $.settings.models.picker.menu.chatSettings;
    });
    content = (
      <ChatModelSettings
        {...props}
        selection={page.selection}
        from={page.from}
      />
    );
  } else if (page.category === "chat") {
    label = t(($) => {
      return $.settings.models.picker.chatModels;
    });
    content = <ChatModelList {...props} />;
  } else {
    label =
      page.category === "image"
        ? t(($) => {
            return $.settings.models.picker.imageModels;
          })
        : t(($) => {
            return $.settings.models.picker.videoModels;
          });
    content = <MediaModelList {...props} categoryId={page.category} />;
  }
  return (
    <div
      key={page.kind === "models" ? page.category : page.kind}
      ref={focusPanel}
      role="region"
      aria-label={label}
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      onKeyDown={(event) => {
        if (event.key === "Escape" && page.kind !== "overview") {
          event.preventDefault();
          event.stopPropagation();
          back();
        } else {
          moveMenuFocus(event);
        }
      }}
    >
      {content}
    </div>
  );
}
