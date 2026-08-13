import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { Check, ChevronLeft, ChevronRight, Cpu, Zap } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  getProvidersForModel,
  isCodexFastModeModel,
  isSupportedRunModel,
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  PUBLIC_VIDEO_MODELS,
  VIDEO_MODEL_CONFIGS,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { useTranslation } from "react-i18next";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies";
import { userModelPreference$ } from "../../../signals/external/user-model-preference";
import {
  DEFAULT_MODEL_PLAN_CAPABILITIES,
  modelAllowedForPlan,
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
  type ModelPlanCapabilities,
} from "../../../signals/zero-page/model-plan-capabilities";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../signals/page-signal";
import { resolveExplicitModelSelection$ } from "../../../signals/zero-page/model-default-selection";
import { detach, Reason } from "../../../signals/utils";
import {
  getModelBrandIconType,
  getVm0ModelPriceTier,
  getVm0ModelPriceTierLabel,
  type Vm0ModelPriceTier,
} from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";

export interface ModelProviderSelection {
  selectedModel: SupportedRunModel;
  codexServiceTier?: CodexServiceTier;
}

/**
 * Video model side of the picker. The run model list and this one share a
 * popover but nothing else: video models carry no provider routing, no price
 * tier, and no plan gate, so every catalog model is offered to everyone.
 *
 * `value` is `null` when the caller has pinned nothing and follows its own
 * default. That is a state the user can return to, so the panel lists it
 * alongside the models rather than treating it as "no selection".
 */
export interface VideoModelPickerState {
  readonly value: VideoModel | null;
  readonly onChange: (next: VideoModel | null) => void;
  readonly panelOpen: boolean;
  readonly onPanelOpenChange: (open: boolean) => void;
}

interface ModelProviderPickerProps {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
  /**
   * Classes applied to the picker trigger. Defaults to `h-9 w-full`. The
   * composer passes an auto-width, compact variant to fit next to Send.
   */
  triggerClassName?: string;
  /**
   * When true, the trigger shows only the friendly model name (no provider
   * label, no price tier badge). Used by the chat composer where horizontal
   * space is tight and the full breakdown lives in the open dropdown.
   */
  compactTrigger?: boolean;
  /**
   * When true, the trigger renders as a provider icon on mobile while keeping
   * the normal label on larger screens.
   */
  mobileIconTrigger?: boolean;
  /** Controlled open state for programmatic toggle (e.g. keyboard shortcut). */
  open?: boolean;
  /** Callback when the open state changes. */
  onOpenChange?: (open: boolean) => void;
  // When true, picker is read-only for the current caller state.
  disabled?: boolean;
  /**
   * When false, the trigger renders only the explicit value. Existing thread
   * composers use this because thread model state comes from event projection,
   * not user/workspace defaults.
   */
  resolveDefaultSelection?: boolean;
  /** Enables the inline Codex Fast choices in the model list. */
  codexFastModeEnabled?: boolean;
  /**
   * When provided, the dropdown gains a row that opens the video model panel.
   * Omitted by callers that have nothing to pin the video model to.
   */
  videoModel?: VideoModelPickerState;
}

// Keep the inherit option distinct from an empty model identifier at the UI
// boundary so its value remains stable across controlled Select updates.
const INHERIT_SENTINEL = "__inherit_default__";
const CODEX_FAST_OPTION_PREFIX = "__codex_fast_option__:";
const CODEX_FAST_SELECTED_PREFIX = "__codex_fast_selected__:";

// Select uses the selected item's offsetHeight as the scroll-button
// step. Keep hidden selected items measurable so native hover scrolling works.
// These items are also `disabled`, and SelectItem's base `data-[disabled]:opacity-50`
// outranks a plain `opacity-0` on specificity, so restate the hidden opacity under
// the disabled variant to stop the measuring item from bleeding through.
const MEASURABLE_HIDDEN_SELECT_ITEM_CLASS =
  "absolute left-0 top-0 h-8 w-px overflow-hidden opacity-0 data-[disabled]:opacity-0 pointer-events-none";

function PriceTierBadge({ tier }: { tier: Vm0ModelPriceTier }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            {tier}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {getVm0ModelPriceTierLabel(tier)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ByokBadge() {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            BYOK
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t(($) => {
            return $.settings.models.picker.byokHelp;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProBadge() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary-foreground">
      {t(($) => {
        return $.settings.models.picker.pro;
      })}
    </span>
  );
}

function ResponsiveTriggerContent({
  mobileIcon,
  iconType,
  label,
}: {
  mobileIcon: boolean;
  iconType: ModelProviderType | undefined;
  label: ReactNode;
}) {
  if (!mobileIcon) {
    return label;
  }
  return (
    <span className="flex items-center min-w-0">
      <span className="flex items-center justify-center sm:hidden">
        {iconType ? (
          <ProviderIcon type={iconType} size={18} />
        ) : (
          <Cpu size={18} />
        )}
      </span>
      <span className="hidden min-w-0 sm:inline-flex sm:items-center sm:gap-1.5">
        {iconType && <ProviderIcon type={iconType} size={16} />}
        {label}
      </span>
    </span>
  );
}

// Read-only span reuses the trigger's geometry classes but must not echo
// its interactive affordances (hover/focus/open-state), so callers don't
// have to branch their className for the disabled case.
function stripInteractiveClasses(cls: string | undefined): string | undefined {
  if (!cls) {
    return cls;
  }
  return cls
    .split(/\s+/)
    .filter((c) => {
      return (
        !c.startsWith("hover:") &&
        !c.startsWith("focus:") &&
        !c.startsWith("focus-visible:") &&
        !c.startsWith("active:") &&
        !c.startsWith("data-popup-open:")
      );
    })
    .join(" ");
}

function getModelFirstIconType(model: string): ModelProviderType | undefined {
  if (isSupportedRunModel(model)) {
    return getModelBrandIconType(model);
  }
  const vm0Entry = VM0_MODEL_TO_PROVIDER[model];
  if (vm0Entry) {
    return vm0Entry.concreteType as ModelProviderType;
  }
  return getProvidersForModel(model).find((type) => {
    return type !== "vm0";
  });
}

function resolveModelFirstDefault(
  value: ModelProviderSelection | null,
  userPreference: { selectedModel: string | null } | null | undefined,
  policies: OrgModelPolicy[],
): ModelProviderSelection | null {
  const validUserDefault =
    userPreference?.selectedModel &&
    isSupportedRunModel(userPreference.selectedModel) &&
    policies.some((policy) => {
      return (
        policy.model === userPreference.selectedModel &&
        policy.routeStatus === "valid"
      );
    })
      ? {
          selectedModel: userPreference.selectedModel,
        }
      : null;
  const validWorkspaceDefault = policies.find((policy) => {
    return (
      policy.isDefault &&
      policy.routeStatus === "valid" &&
      isSupportedRunModel(policy.model)
    );
  });
  return (
    value ??
    validUserDefault ??
    (validWorkspaceDefault
      ? {
          selectedModel: validWorkspaceDefault.model,
        }
      : null)
  );
}

function selectablePoliciesForPlan(
  policies: OrgModelPolicy[],
  modelCapabilities: ModelPlanCapabilities,
): OrgModelPolicy[] {
  if (modelCapabilities.supportByok && !modelCapabilities.restrictedVm0Models) {
    return policies;
  }
  return policies.filter((policy) => {
    return modelPolicyAllowedForPlan(policy, modelCapabilities);
  });
}

function selectionAllowedValue(
  value: ModelProviderSelection | null,
  policies: OrgModelPolicy[],
  modelCapabilities: ModelPlanCapabilities,
): ModelProviderSelection | null {
  if (!value) {
    return null;
  }
  const policy = policies.find((candidate) => {
    return candidate.model === value.selectedModel;
  });
  const allowed = policy
    ? modelPolicyAllowedForPlan(policy, modelCapabilities)
    : modelAllowedForPlan(value.selectedModel, modelCapabilities);
  return allowed ? value : null;
}

function selectionLabel({
  selection,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): string {
  if (!selection) {
    return placeholder;
  }
  const modelLabel = getCanonicalModelDisplayName(selection.selectedModel);
  return codexFastModeEnabled && selection.codexServiceTier === "fast"
    ? `${modelLabel} ${fastLabel}`
    : modelLabel;
}

function ModelFirstTriggerLabel({
  selection,
  placeholder,
  mobileIcon,
  codexFastModeEnabled,
  fastLabel,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  mobileIcon: boolean;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  if (!selection) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const iconType = getModelFirstIconType(selection.selectedModel);
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={
        <span className="min-w-0 truncate">
          {selectionLabel({
            selection,
            placeholder,
            codexFastModeEnabled,
            fastLabel,
          })}
        </span>
      }
    />
  );
}

function ModelFirstDisabledPickerLabel({
  value,
  placeholder,
  mobileIconTrigger,
  triggerClassName,
  userPreference,
  policies,
  codexFastModeEnabled,
  fastLabel,
}: Pick<
  ModelProviderPickerProps,
  | "value"
  | "placeholder"
  | "compactTrigger"
  | "mobileIconTrigger"
  | "triggerClassName"
> & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  policies: OrgModelPolicy[];
  userPreference: { selectedModel: string | null } | null | undefined;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const resolved = resolveModelFirstDefault(value, userPreference, policies);
  const label = selectionLabel({
    selection: resolved,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex items-center px-2 text-sm text-muted-foreground cursor-default",
        stripInteractiveClasses(triggerClassName),
      )}
    >
      <ModelFirstTriggerLabel
        selection={resolved}
        placeholder={placeholder}
        mobileIcon={mobileIconTrigger}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  if (raw.startsWith(CODEX_FAST_OPTION_PREFIX)) {
    const selectedModel = raw.slice(CODEX_FAST_OPTION_PREFIX.length);
    if (
      codexFastModeEnabled &&
      isSupportedRunModel(selectedModel) &&
      isCodexFastModeModel(selectedModel)
    ) {
      return { selectedModel, codexServiceTier: "fast" };
    }
    return null;
  }
  if (!isSupportedRunModel(raw)) {
    return null;
  }
  return {
    selectedModel: raw,
  };
}

function modelFirstSelectValue(
  selection: ModelProviderSelection | null,
): string {
  if (!selection) {
    return INHERIT_SENTINEL;
  }
  return selection.codexServiceTier === "fast"
    ? `${CODEX_FAST_SELECTED_PREFIX}${selection.selectedModel}`
    : selection.selectedModel;
}

function codexFastOptionValue(model: string): string {
  return `${CODEX_FAST_OPTION_PREFIX}${model}`;
}

function modelFirstSelectionFromInteraction(
  raw: string,
  currentSelection: ModelProviderSelection | null,
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null | undefined {
  if (codexFastModeEnabled && currentSelection?.codexServiceTier === "fast") {
    if (raw === currentSelection.selectedModel) {
      return undefined;
    }
    if (raw === codexFastOptionValue(currentSelection.selectedModel)) {
      return { selectedModel: currentSelection.selectedModel };
    }
  }
  return modelFirstSelectionFromRaw(raw, codexFastModeEnabled);
}

function isHiddenModelFirstSelectValue(value: string): boolean {
  return (
    value === INHERIT_SENTINEL || value.startsWith(CODEX_FAST_SELECTED_PREFIX)
  );
}

function ModelFirstPolicyRowContent({
  policy,
  modelCapabilities,
  selected = false,
  showSelectedIndicator = false,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selected?: boolean;
  showSelectedIndicator?: boolean;
}) {
  const iconType = getModelFirstIconType(policy.model);
  const builtInPriceTier =
    policy.defaultProviderType === "vm0"
      ? getVm0ModelPriceTier(policy.model)
      : undefined;
  const restricted = !modelPolicyAllowedForPlan(policy, modelCapabilities);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {iconType && <ProviderIcon type={iconType} size={16} />}
      <span className="min-w-0 flex-1 truncate">
        {policy.modelLabel || getCanonicalModelDisplayName(policy.model)}
      </span>
      {builtInPriceTier !== undefined ? (
        <PriceTierBadge tier={builtInPriceTier} />
      ) : (
        <ByokBadge />
      )}
      {restricted && <ProBadge />}
      {showSelectedIndicator && (
        <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center text-foreground">
          {selected && <Check size={15} />}
        </span>
      )}
    </span>
  );
}

function ModelFirstPolicyRow({
  policy,
  modelCapabilities,
  selection,
  codexFastModeEnabled,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selection: ModelProviderSelection | null;
  codexFastModeEnabled: boolean;
}) {
  const { t } = useTranslation();
  const fastAvailable =
    codexFastModeEnabled &&
    policy.routeStatus === "valid" &&
    isCodexFastModeModel(policy.model);
  if (fastAvailable) {
    const modelLabel =
      policy.modelLabel || getCanonicalModelDisplayName(policy.model);
    const selected = selection?.selectedModel === policy.model;
    const fastSelected = selected && selection.codexServiceTier === "fast";
    const fastLabel = t(($) => {
      return $.settings.models.picker.fast;
    });
    const fastImpact = t(($) => {
      return $.settings.models.picker.fastImpact;
    });
    return (
      <div
        className={cn(
          "relative flex overflow-hidden rounded-lg transition-colors hover:bg-state-hover has-[[data-highlighted]]:bg-state-hover",
          selected &&
            "bg-state-selected hover:bg-state-selected-hover has-[[data-highlighted]]:bg-state-selected-hover",
        )}
      >
        <SelectItem
          value={policy.model}
          aria-label={modelLabel}
          className={cn(
            "min-w-0 flex-1 rounded-lg pr-8 hover:bg-transparent data-highlighted:bg-transparent",
            selected && "mr-8",
          )}
        >
          <ModelFirstPolicyRowContent
            policy={policy}
            modelCapabilities={modelCapabilities}
            selected={selected}
            showSelectedIndicator={fastSelected}
          />
        </SelectItem>
        <TooltipProvider delayDuration={800} skipDelayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectItem
                value={codexFastOptionValue(policy.model)}
                aria-label={`${modelLabel} ${fastLabel}`}
                className={cn(
                  "group/fast-option absolute inset-y-0 right-0 w-8 justify-center rounded-lg px-0 text-muted-foreground hover:bg-transparent data-highlighted:bg-transparent",
                  fastSelected &&
                    "text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200",
                )}
              >
                <Zap
                  size={18}
                  fill={fastSelected ? "currentColor" : "none"}
                  className={cn(
                    fastSelected
                      ? "group-hover/fast-option:fill-none group-data-[highlighted]/fast-option:fill-none"
                      : "group-hover/fast-option:fill-current group-data-[highlighted]/fast-option:fill-current",
                  )}
                  aria-hidden="true"
                />
              </SelectItem>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {fastLabel} · {fastImpact}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }
  return (
    <SelectItem
      key={policy.id}
      value={policy.model}
      disabled={policy.routeStatus !== "valid"}
    >
      <ModelFirstPolicyRowContent
        policy={policy}
        modelCapabilities={modelCapabilities}
      />
    </SelectItem>
  );
}

function ModelFirstPolicyItems({
  policies,
  selection,
  modelCapabilities,
  codexFastModeEnabled,
  showSeparator = true,
}: {
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  showSeparator?: boolean;
}) {
  const { t } = useTranslation();
  const explicitSelectedModel = selection?.selectedModel ?? null;
  const hasExplicitSelectedPolicy =
    explicitSelectedModel === null ||
    policies.some((policy) => {
      return policy.model === explicitSelectedModel;
    });
  return (
    <>
      {showSeparator && (!hasExplicitSelectedPolicy || policies.length > 0) && (
        <SelectSeparator className="my-0" />
      )}
      {!hasExplicitSelectedPolicy && explicitSelectedModel && (
        <SelectItem
          value={explicitSelectedModel}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {getCanonicalModelDisplayName(explicitSelectedModel)}
        </SelectItem>
      )}
      {policies.length === 0 ? (
        <div className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.picker.noConfiguredModels;
          })}
        </div>
      ) : (
        <SelectGroup>
          <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.models;
            })}
          </SelectLabel>
          {policies.map((policy) => {
            return (
              <ModelFirstPolicyRow
                key={policy.id}
                policy={policy}
                modelCapabilities={modelCapabilities}
                selection={selection}
                codexFastModeEnabled={codexFastModeEnabled}
              />
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

// Rows in the video panel are plain buttons rather than SelectItems: the
// Select's value space belongs to the run model, and a SelectItem here would
// both join it and close the popover on click.
const VIDEO_PANEL_ROW_CLASS =
  "relative flex w-full cursor-pointer select-none items-center rounded-lg py-1.5 pl-2 pr-8 text-left text-sm outline-none transition-colors hover:bg-state-hover hover:text-accent-foreground";

function VideoModelPanelRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      className={VIDEO_PANEL_ROW_CLASS}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && (
        <Check size={15} className="absolute right-2 text-foreground" />
      )}
    </button>
  );
}

function VideoModelPanel({
  videoModel,
}: {
  videoModel: VideoModelPickerState;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-lg py-1.5 pl-1 pr-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-state-hover hover:text-foreground"
        onClick={() => {
          videoModel.onPanelOpenChange(false);
        }}
      >
        <ChevronLeft size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {t(($) => {
            return $.settings.models.picker.videoModels;
          })}
        </span>
      </button>
      <VideoModelPanelRow
        label={t(($) => {
          return $.settings.models.picker.videoModelUseDefault;
        })}
        selected={videoModel.value === null}
        onSelect={() => {
          videoModel.onChange(null);
        }}
      />
      <SelectSeparator className="my-0" />
      {PUBLIC_VIDEO_MODELS.map((candidate) => {
        return (
          <VideoModelPanelRow
            key={candidate}
            label={VIDEO_MODEL_CONFIGS[candidate].label}
            selected={videoModel.value === candidate}
            onSelect={() => {
              videoModel.onChange(candidate);
            }}
          />
        );
      })}
    </>
  );
}

function ManageMoreModelsRow({
  videoModel,
}: {
  videoModel: VideoModelPickerState;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SelectSeparator className="my-0" />
      <button
        type="button"
        className={VIDEO_PANEL_ROW_CLASS}
        onClick={() => {
          videoModel.onPanelOpenChange(true);
        }}
      >
        <span className="min-w-0 flex-1 truncate">
          {t(($) => {
            return $.settings.models.picker.manageMoreModels;
          })}
        </span>
        <ChevronRight
          size={15}
          className="absolute right-2 text-muted-foreground"
          aria-hidden="true"
        />
      </button>
    </>
  );
}

interface ModelFirstModelPickerContentBaseProps {
  selectValue: string;
  placeholder: string;
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  videoModel: VideoModelPickerState | undefined;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  policies,
  selection,
  modelCapabilities,
  codexFastModeEnabled,
  fastLabel,
  videoModel,
}: ModelFirstModelPickerContentBaseProps) {
  const videoPanelOpen = videoModel?.panelOpen ?? false;
  return (
    <SelectContent className="max-h-[280px] min-w-[260px]">
      {/* The video panel replaces the model rows, so keep the selected run
          model measurable the same way a hidden select value is. */}
      {(videoPanelOpen || isHiddenModelFirstSelectValue(selectValue)) && (
        <SelectItem
          value={selectValue}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {selectionLabel({
            selection,
            placeholder,
            codexFastModeEnabled,
            fastLabel,
          })}
        </SelectItem>
      )}
      {videoModel && videoPanelOpen ? (
        <VideoModelPanel videoModel={videoModel} />
      ) : (
        <>
          <ModelFirstPolicyItems
            policies={policies}
            selection={selection}
            modelCapabilities={modelCapabilities}
            codexFastModeEnabled={codexFastModeEnabled}
            showSeparator={false}
          />
          {videoModel && <ManageMoreModelsRow videoModel={videoModel} />}
        </>
      )}
    </SelectContent>
  );
}

interface ModelFirstModelPickerState {
  policies: OrgModelPolicy[];
  selectablePolicies: OrgModelPolicy[];
  selectableValue: ModelProviderSelection | null;
  selection: ModelProviderSelection | null;
  selectValue: string;
  triggerAriaLabel: string;
}

function resolveModelFirstModelPickerState({
  value,
  userPreference,
  policyResponse,
  modelCapabilities,
  resolveDefaultSelection,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  userPreference: { selectedModel: string | null } | null | undefined;
  policyResponse: { policies: OrgModelPolicy[] } | null | undefined;
  modelCapabilities: ModelPlanCapabilities;
  resolveDefaultSelection: boolean;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): ModelFirstModelPickerState {
  const policies = policyResponse?.policies ?? [];
  const selectablePolicies = selectablePoliciesForPlan(
    policies,
    modelCapabilities,
  );
  const selectableValue = selectionAllowedValue(
    value,
    policies,
    modelCapabilities,
  );
  const resolved = resolveDefaultSelection
    ? resolveModelFirstDefault(
        selectableValue,
        userPreference,
        selectablePolicies,
      )
    : selectableValue;
  return {
    policies,
    selectablePolicies,
    selectableValue,
    selection: resolved,
    selectValue: modelFirstSelectValue(resolved),
    triggerAriaLabel: selectionLabel({
      selection: resolved,
      placeholder,
      codexFastModeEnabled,
      fastLabel,
    }),
  };
}

function ModelFirstSelectPicker({
  state,
  content,
  placeholder,
  triggerClassName,
  mobileIconTrigger,
  modelCapabilities,
  codexFastModeEnabled,
  fastLabel,
  videoModel,
  open,
  onOpenChange,
  onValueChange,
}: {
  state: ModelFirstModelPickerState;
  content?: ReactNode;
  placeholder: string;
  triggerClassName: string | undefined;
  mobileIconTrigger: boolean;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  videoModel: VideoModelPickerState | undefined;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  onValueChange: (raw: string) => void;
}) {
  return (
    <Select
      value={state.selectValue}
      onValueChange={onValueChange}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        aria-label={state.triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerLabel
            selection={state.selection}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
            codexFastModeEnabled={codexFastModeEnabled}
            fastLabel={fastLabel}
          />
        </SelectValue>
      </SelectTrigger>
      {open !== false &&
        (content ?? (
          <ModelFirstModelPickerContentLayout
            selectValue={state.selectValue}
            placeholder={placeholder}
            policies={state.policies}
            selection={state.selection}
            modelCapabilities={modelCapabilities}
            codexFastModeEnabled={codexFastModeEnabled}
            fastLabel={fastLabel}
            videoModel={videoModel}
          />
        ))}
    </Select>
  );
}

function SubscribedModelFirstModelPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  compactTrigger,
  mobileIconTrigger,
  open,
  onOpenChange,
  disabled,
  userPreference,
  resolveDefaultSelection,
  codexFastModeEnabled = false,
  fastLabel,
  videoModel,
}: ModelProviderPickerProps & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  userPreference: { selectedModel: string | null } | null | undefined;
  resolveDefaultSelection: boolean;
  fastLabel: string;
}) {
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const modelCapabilitiesLoadable = useLoadable(modelPlanCapabilities$);
  const lastModelCapabilities = useLastResolved(modelPlanCapabilities$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const policyResponse =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : undefined;
  const modelCapabilities =
    modelCapabilitiesLoadable.state === "hasData"
      ? modelCapabilitiesLoadable.data
      : (lastModelCapabilities ?? DEFAULT_MODEL_PLAN_CAPABILITIES);
  const state = resolveModelFirstModelPickerState({
    value,
    userPreference,
    policyResponse,
    modelCapabilities,
    resolveDefaultSelection,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });

  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={state.selectableValue}
        placeholder={placeholder}
        compactTrigger={compactTrigger}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        userPreference={resolveDefaultSelection ? userPreference : null}
        policies={resolveDefaultSelection ? state.selectablePolicies : []}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }

  const openComparePlans = () => {
    openBillingPlans();
    detach(openSettings(true, pageSignal), Reason.DomCallback);
  };

  const handleRawValueChange = (raw: string) => {
    const selection = modelFirstSelectionFromInteraction(
      raw,
      state.selection,
      codexFastModeEnabled,
    );
    if (selection === undefined) {
      return;
    }
    if (selection) {
      const policy = state.policies.find((candidate) => {
        return candidate.model === selection.selectedModel;
      });
      if (
        !modelAllowedForPlan(selection.selectedModel, modelCapabilities) ||
        (policy !== undefined &&
          !modelPolicyAllowedForPlan(policy, modelCapabilities))
      ) {
        openComparePlans();
        return;
      }
    }
    onChange(selection);
  };

  return (
    <ModelFirstSelectPicker
      state={state}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      mobileIconTrigger={mobileIconTrigger}
      modelCapabilities={modelCapabilities}
      codexFastModeEnabled={codexFastModeEnabled}
      fastLabel={fastLabel}
      videoModel={videoModel}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={handleRawValueChange}
    />
  );
}

function resolveExplicitModelFirstModelPickerState({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): ModelFirstModelPickerState {
  return {
    policies: [],
    selectablePolicies: [],
    selectableValue: value,
    selection: value,
    selectValue: modelFirstSelectValue(value),
    triggerAriaLabel: selectionLabel({
      selection: value,
      placeholder,
      codexFastModeEnabled,
      fastLabel,
    }),
  };
}

function LoadingModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const { t } = useTranslation();
  const selectValue = modelFirstSelectValue(value);
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={selectValue}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {selectionLabel({
          selection: value,
          placeholder,
          codexFastModeEnabled,
          fastLabel,
        })}
      </SelectItem>
      <div className="px-2 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.models.picker.loading;
        })}
      </div>
    </SelectContent>
  );
}

function ErrorModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const { t } = useTranslation();
  const selectValue = modelFirstSelectValue(value);
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={selectValue}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {selectionLabel({
          selection: value,
          placeholder,
          codexFastModeEnabled,
          fastLabel,
        })}
      </SelectItem>
      <div className="px-2 py-2 text-sm text-muted-foreground">
        {t(($) => {
          return $.settings.models.picker.loadError;
        })}
      </div>
    </SelectContent>
  );
}

function SubscribedExplicitModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
  videoModel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  videoModel: VideoModelPickerState | undefined;
}) {
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const modelCapabilities =
    useLastResolved(modelPlanCapabilities$) ?? DEFAULT_MODEL_PLAN_CAPABILITIES;
  if (policiesLoadable.state === "loading") {
    return (
      <LoadingModelFirstModelPickerContent
        value={value}
        placeholder={placeholder}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }
  if (policiesLoadable.state === "hasError") {
    return (
      <ErrorModelFirstModelPickerContent
        value={value}
        placeholder={placeholder}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }
  const state = resolveModelFirstModelPickerState({
    value,
    userPreference: null,
    policyResponse: policiesLoadable.data,
    modelCapabilities: DEFAULT_MODEL_PLAN_CAPABILITIES,
    resolveDefaultSelection: false,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });
  return (
    <ModelFirstModelPickerContentLayout
      selectValue={state.selectValue}
      placeholder={placeholder}
      policies={state.policies}
      selection={state.selection}
      modelCapabilities={modelCapabilities}
      codexFastModeEnabled={codexFastModeEnabled}
      fastLabel={fastLabel}
      videoModel={videoModel}
    />
  );
}

function EnabledExplicitModelFirstModelPicker(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  const resolveSelection = useSet(resolveExplicitModelSelection$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const state = resolveExplicitModelFirstModelPickerState({
    value: props.value,
    placeholder: props.placeholder,
    codexFastModeEnabled: props.codexFastModeEnabled ?? false,
    fastLabel: props.fastLabel,
  });
  const handleRawValueChange = (raw: string) => {
    const selection = modelFirstSelectionFromInteraction(
      raw,
      state.selection,
      props.codexFastModeEnabled ?? false,
    );
    if (selection === undefined) {
      return;
    }
    detach(
      (async () => {
        const result = await resolveSelection(
          {
            selection,
          },
          pageSignal,
        );
        if (result.kind === "compare-plans") {
          openBillingPlans();
          await openSettings(true, pageSignal);
          return;
        }
        props.onChange(result.selection);
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <ModelFirstSelectPicker
      state={state}
      content={
        props.open !== false ? (
          <SubscribedExplicitModelFirstModelPickerContent
            value={props.value}
            placeholder={props.placeholder}
            codexFastModeEnabled={props.codexFastModeEnabled ?? false}
            fastLabel={props.fastLabel}
            videoModel={props.videoModel}
          />
        ) : undefined
      }
      placeholder={props.placeholder}
      triggerClassName={props.triggerClassName}
      mobileIconTrigger={props.mobileIconTrigger}
      modelCapabilities={DEFAULT_MODEL_PLAN_CAPABILITIES}
      codexFastModeEnabled={props.codexFastModeEnabled ?? false}
      fastLabel={props.fastLabel}
      videoModel={props.videoModel}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onValueChange={handleRawValueChange}
    />
  );
}

function ModelFirstModelPicker(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  if (props.disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={props.value}
        placeholder={props.placeholder}
        compactTrigger={props.compactTrigger}
        mobileIconTrigger={props.mobileIconTrigger}
        triggerClassName={props.triggerClassName}
        userPreference={null}
        policies={[]}
        codexFastModeEnabled={props.codexFastModeEnabled ?? false}
        fastLabel={props.fastLabel}
      />
    );
  }
  return <EnabledExplicitModelFirstModelPicker {...props} />;
}

function ModelFirstModelPickerWithDefaultSelection(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  const userPreference = useLastResolved(userModelPreference$);
  return (
    <SubscribedModelFirstModelPicker
      {...props}
      userPreference={userPreference}
      resolveDefaultSelection
    />
  );
}

export function ModelProviderPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  compactTrigger = false,
  mobileIconTrigger = false,
  open,
  onOpenChange,
  disabled = false,
  resolveDefaultSelection = true,
  codexFastModeEnabled = false,
  videoModel,
}: ModelProviderPickerProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder =
    placeholder ??
    t(($) => {
      return $.settings.models.picker.inheritDefault;
    });
  const fastLabel = t(($) => {
    return $.settings.models.picker.fast;
  });
  const props = {
    value,
    onChange,
    placeholder: resolvedPlaceholder,
    triggerClassName,
    compactTrigger,
    mobileIconTrigger,
    open,
    onOpenChange,
    disabled,
    codexFastModeEnabled,
    fastLabel,
    ...(videoModel ? { videoModel } : {}),
  };
  if (resolveDefaultSelection) {
    return <ModelFirstModelPickerWithDefaultSelection {...props} />;
  }
  return <ModelFirstModelPicker {...props} />;
}
