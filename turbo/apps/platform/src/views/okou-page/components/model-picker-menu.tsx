import type { KeyboardEvent, ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cpu,
  MessageCircle,
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
                  editSettings();
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
  onChange,
}: Pick<ModelPickerMenuContentProps, "signals" | "options" | "onChange"> & {
  selection: ModelProviderSelection;
}) {
  const { t } = useTranslation();
  const back = useSet(signals.reset$);
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
        backLabel={t(($) => {
          return $.settings.models.picker.menu.backToModels;
        })}
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
          onCheckedChange={(fast) => {
            onChange({
              selectedModel: selection.selectedModel,
              ...(fast ? { codexServiceTier: "fast" } : {}),
            });
          }}
          disabled={!option?.fastAvailable || option.disabled}
        />
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
  const reset = useSet(signals.reset$);
  const chooseChat = (option: ModelPickerMenuOption) => {
    onChange(
      value?.selectedModel === option.model
        ? value
        : { selectedModel: option.model },
    );
    reset();
  };
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.chatModels;
        })}
        onBack={reset}
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
        onBack={reset}
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
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
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

/**
 * Flyout layout: model types on the left, that type's models in a panel beside
 * it. The two panels are separate cards -- joining them would make the root
 * resize whenever a longer list opened, and the type rows would move out from
 * under the pointer.
 */
function ModelPickerFlyoutTypeRow({
  icon,
  label,
  current,
  active,
  index,
  total,
  onActivate,
}: {
  icon: ReactNode;
  label: string;
  current: string;
  active: boolean;
  index: number;
  total: number;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-posinset={index + 1}
      aria-setsize={total}
      tabIndex={active ? 0 : -1}
      className={cn(
        "flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors",
        "hover:bg-state-hover focus-visible:ring-inset",
        active && "bg-state-hover",
      )}
      onMouseEnter={onActivate}
      onFocus={onActivate}
      onClick={onActivate}
    >
      <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[13px] leading-[17px] text-foreground">
          {label}
        </span>
        <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
          {current}
        </span>
      </span>
      <ChevronRight
        size={13}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
      />
    </button>
  );
}

function ModelPickerFlyoutOption({
  content,
  selected,
  disabled,
  index,
  total,
  onSelect,
}: {
  content: ReactNode;
  selected: boolean;
  disabled: boolean;
  index: number;
  total: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      // Unavailable routes stay in the list and stay reachable: a native
      // disabled row is invisible to keyboard and screen reader users.
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cn(
        "relative flex h-9 w-full items-center gap-2 rounded-lg py-0 pl-2 pr-8 text-left",
        "text-[13px] font-normal text-foreground transition-colors",
        "focus-visible:ring-inset",
        disabled ? "opacity-55" : "hover:bg-state-hover",
      )}
      onClick={() => {
        if (!disabled) {
          onSelect();
        }
      }}
    >
      {content}
      {selected && (
        <Check size={15} aria-hidden="true" className="absolute right-2" />
      )}
    </button>
  );
}

function ModelPickerFlyoutOptions({
  activeMedia,
  options,
  value,
  onChange,
}: {
  activeMedia: MediaModelPanelState["categories"][number] | undefined;
  options: readonly ModelPickerMenuOption[];
  value: ModelProviderSelection | null;
  onChange: (selection: ModelProviderSelection) => void;
}) {
  if (activeMedia) {
    return activeMedia.options.map((option, index) => {
      return (
        <ModelPickerFlyoutOption
          key={option.key}
          content={
            <>
              {option.icon}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <PriceTierBadge
                tier={option.priceTier}
                description={getMediaModelPriceTierLabel(option.priceTier)}
              />
            </>
          }
          selected={option.selected}
          disabled={false}
          index={index}
          total={activeMedia.options.length}
          onSelect={option.onSelect}
        />
      );
    });
  }
  return options.map((option, index) => {
    return (
      <ModelPickerFlyoutOption
        key={option.model}
        content={option.content}
        selected={value?.selectedModel === option.model}
        disabled={option.disabled}
        index={index}
        total={options.length}
        onSelect={() => {
          onChange(
            value?.selectedModel === option.model
              ? value
              : { selectedModel: option.model },
          );
        }}
      />
    );
  });
}

export function ModelPickerFlyoutContent({
  signals,
  value,
  placeholder,
  options,
  mediaModelPanel,
  onChange,
}: ModelPickerMenuContentProps) {
  const { t } = useTranslation();
  const category = useGet(signals.flyoutCategory$);
  const side = useGet(signals.flyoutSide$);
  const setCategory = useSet(signals.setFlyoutCategory$);
  const rootRef = useSet(signals.flyoutRootRef$);
  const panelRef = useSet(signals.focusFlyoutPanelRef$);
  const selectedOption = options.find((option) => {
    return option.model === value?.selectedModel;
  });
  const chatLabel =
    selectedOption?.label ??
    (value ? getCanonicalModelDisplayName(value.selectedModel) : placeholder);
  const types = [
    {
      id: "chat" as const,
      label: t(($) => {
        return $.settings.models.picker.categoryChat;
      }),
      current: chatLabel,
      icon: <MessageCircle size={15} aria-hidden="true" />,
    },
    ...(mediaModelPanel?.categories ?? []).map((mediaCategory) => {
      const selected = mediaCategory.options.find((option) => {
        return option.selected;
      });
      return {
        id: mediaCategory.id,
        label: mediaCategory.tabLabel,
        current: selected?.label ?? mediaCategory.label,
        icon: selected?.icon ?? null,
      };
    }),
  ];
  const activeType = types.some((type) => {
    return type.id === category;
  })
    ? category
    : "chat";
  const activeMedia = mediaModelPanel?.categories.find((mediaCategory) => {
    return mediaCategory.id === activeType;
  });
  const panelLabel =
    activeMedia?.label ??
    t(($) => {
      return $.settings.models.picker.chatModels;
    });
  return (
    <div
      ref={rootRef}
      className="relative w-[188px]"
      onKeyDown={(event) => {
        moveFlyoutFocus(event, types.length);
      }}
    >
      {types.length > 1 && (
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label={t(($) => {
            return $.settings.models.picker.models;
          })}
          className="flex flex-col gap-0.5 rounded-xl border border-border bg-popover p-1 shadow-md"
        >
          {types.map((type, index) => {
            return (
              <ModelPickerFlyoutTypeRow
                key={type.id}
                icon={type.icon}
                label={type.label}
                current={type.current}
                active={type.id === activeType}
                index={index}
                total={types.length}
                onActivate={() => {
                  setCategory(type.id);
                }}
              />
            );
          })}
        </div>
      )}
      <div
        ref={panelRef}
        role="listbox"
        aria-label={panelLabel}
        className={cn(
          "flex max-h-[284px] w-[252px] flex-col gap-0.5 overflow-y-auto overscroll-contain",
          "rounded-xl border border-border bg-popover p-1 shadow-md",
          types.length > 1
            ? cn(
                "absolute bottom-0",
                side === "right"
                  ? "left-[calc(100%+6px)]"
                  : "right-[calc(100%+6px)]",
              )
            : "w-[252px]",
        )}
      >
        <ModelPickerFlyoutOptions
          activeMedia={activeMedia}
          options={options}
          value={value}
          onChange={onChange}
        />
        {options.length === 0 && !activeMedia && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.noConfiguredModels;
            })}
          </p>
        )}
      </div>
    </div>
  );
}

/** Vertical tablist paired with a listbox: up/down inside each, arrows across. */
function moveFlyoutFocus(
  event: KeyboardEvent<HTMLDivElement>,
  typeCount: number,
): void {
  const target = event.target as HTMLElement;
  const root = event.currentTarget;
  const onType = target.getAttribute("role") === "tab";
  const options = Array.from(
    root.querySelectorAll<HTMLElement>('[role="option"]'),
  );
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (onType && (event.key === "ArrowRight" || event.key === "Enter")) {
    event.preventDefault();
    (
      options.find((option) => {
        return option.getAttribute("aria-selected") === "true";
      }) ?? options[0]
    )?.focus();
    return;
  }
  if (!onType && event.key === "ArrowLeft" && typeCount > 1) {
    event.preventDefault();
    tabs
      .find((tab) => {
        return tab.getAttribute("aria-selected") === "true";
      })
      ?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const ring = onType ? tabs : options;
  const current = ring.indexOf(target);
  if (current === -1 || ring.length === 0) {
    return;
  }
  event.preventDefault();
  const next =
    (current + (event.key === "ArrowDown" ? 1 : -1) + ring.length) %
    ring.length;
  ring[next]?.focus();
}

export function ModelPickerMenuContent(props: ModelPickerMenuContentProps) {
  const { t } = useTranslation();
  const page = useGet(props.signals.page$);
  const back = useSet(props.signals.reset$);
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
    content = props.value && (
      <ChatModelSettings {...props} selection={props.value} />
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
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 [&_button:focus-visible]:ring-inset [&_button:focus-visible]:ring-offset-0"
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
