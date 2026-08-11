import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { Check, Cpu } from "lucide-react";
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
} from "@vm0/ui";
import {
  getCanonicalModelDisplayName,
  getProvidersForModel,
  isSupportedRunModel,
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
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
}

// Keep the inherit option distinct from an empty model identifier at the UI
// boundary so its value remains stable across controlled Select updates.
const INHERIT_SENTINEL = "__inherit_default__";

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

function ModelFirstTriggerLabel({
  selectedModel,
  placeholder,
  mobileIcon,
}: {
  selectedModel: string | null;
  placeholder: string;
  mobileIcon: boolean;
}) {
  if (!selectedModel) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const iconType = getModelFirstIconType(selectedModel);
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={
        <span className="min-w-0 truncate">
          {getCanonicalModelDisplayName(selectedModel)}
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
}) {
  const resolved = resolveModelFirstDefault(value, userPreference, policies);
  const selectedModel = resolved?.selectedModel ?? null;
  return (
    <span
      aria-label={
        selectedModel
          ? getCanonicalModelDisplayName(selectedModel)
          : placeholder
      }
      className={cn(
        "inline-flex items-center px-2 text-sm text-muted-foreground cursor-default",
        stripInteractiveClasses(triggerClassName),
      )}
    >
      <ModelFirstTriggerLabel
        selectedModel={selectedModel}
        placeholder={placeholder}
        mobileIcon={mobileIconTrigger}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  if (!isSupportedRunModel(raw)) {
    return null;
  }
  return {
    selectedModel: raw,
  };
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
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground">
          {selected && <Check size={15} />}
        </span>
      )}
    </span>
  );
}

function ModelFirstPolicyRow({
  policy,
  modelCapabilities,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
}) {
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
  explicitSelectedModel,
  modelCapabilities,
  showSeparator = true,
}: {
  policies: OrgModelPolicy[];
  explicitSelectedModel: string | null;
  modelCapabilities: ModelPlanCapabilities;
  showSeparator?: boolean;
}) {
  const { t } = useTranslation();
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
              />
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

interface ModelFirstModelPickerContentBaseProps {
  selectValue: string;
  placeholder: string;
  policies: OrgModelPolicy[];
  selectableValue: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  policies,
  selectableValue,
  modelCapabilities,
}: ModelFirstModelPickerContentBaseProps) {
  return (
    <SelectContent className="max-h-[280px] min-w-[260px]">
      {selectValue === INHERIT_SENTINEL && (
        <SelectItem
          value={INHERIT_SENTINEL}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {placeholder}
        </SelectItem>
      )}
      <ModelFirstPolicyItems
        policies={policies}
        explicitSelectedModel={selectableValue?.selectedModel ?? null}
        modelCapabilities={modelCapabilities}
        showSeparator={false}
      />
    </SelectContent>
  );
}

interface ModelFirstModelPickerState {
  policies: OrgModelPolicy[];
  selectablePolicies: OrgModelPolicy[];
  selectableValue: ModelProviderSelection | null;
  selectedModel: string | null;
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
}: {
  value: ModelProviderSelection | null;
  userPreference: { selectedModel: string | null } | null | undefined;
  policyResponse: { policies: OrgModelPolicy[] } | null | undefined;
  modelCapabilities: ModelPlanCapabilities;
  resolveDefaultSelection: boolean;
  placeholder: string;
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
  const selectedModel = resolved?.selectedModel ?? null;
  return {
    policies,
    selectablePolicies,
    selectableValue,
    selectedModel,
    selectValue:
      selectableValue?.selectedModel ?? selectedModel ?? INHERIT_SENTINEL,
    triggerAriaLabel: selectedModel
      ? getCanonicalModelDisplayName(selectedModel)
      : placeholder,
  };
}

function ModelFirstSelectPicker({
  state,
  content,
  placeholder,
  triggerClassName,
  mobileIconTrigger,
  modelCapabilities,
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
            selectedModel={state.selectedModel}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
          />
        </SelectValue>
      </SelectTrigger>
      {open !== false &&
        (content ?? (
          <ModelFirstModelPickerContentLayout
            selectValue={state.selectValue}
            placeholder={placeholder}
            policies={state.policies}
            selectableValue={state.selectableValue}
            modelCapabilities={modelCapabilities}
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
}: ModelProviderPickerProps & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
  userPreference: { selectedModel: string | null } | null | undefined;
  resolveDefaultSelection: boolean;
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
      />
    );
  }

  const openComparePlans = () => {
    openBillingPlans();
    detach(openSettings(true, pageSignal), Reason.DomCallback);
  };

  const handleRawValueChange = (raw: string) => {
    if (raw !== INHERIT_SENTINEL) {
      const policy = state.policies.find((candidate) => {
        return candidate.model === raw;
      });
      if (
        !modelAllowedForPlan(raw, modelCapabilities) ||
        (policy !== undefined &&
          !modelPolicyAllowedForPlan(policy, modelCapabilities))
      ) {
        openComparePlans();
        return;
      }
    }
    onChange(modelFirstSelectionFromRaw(raw));
  };

  return (
    <ModelFirstSelectPicker
      state={state}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      mobileIconTrigger={mobileIconTrigger}
      modelCapabilities={modelCapabilities}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={handleRawValueChange}
    />
  );
}

function resolveExplicitModelFirstModelPickerState({
  value,
  placeholder,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
}): ModelFirstModelPickerState {
  const selectedModel = value?.selectedModel ?? null;
  return {
    policies: [],
    selectablePolicies: [],
    selectableValue: value,
    selectedModel,
    selectValue: selectedModel ?? INHERIT_SENTINEL,
    triggerAriaLabel: selectedModel
      ? getCanonicalModelDisplayName(selectedModel)
      : placeholder,
  };
}

function LoadingModelFirstModelPickerContent({
  value,
  placeholder,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const selectValue = value?.selectedModel ?? INHERIT_SENTINEL;
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={selectValue}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {value?.selectedModel
          ? getCanonicalModelDisplayName(value.selectedModel)
          : placeholder}
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
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const selectValue = value?.selectedModel ?? INHERIT_SENTINEL;
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={selectValue}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {value?.selectedModel
          ? getCanonicalModelDisplayName(value.selectedModel)
          : placeholder}
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
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
}) {
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const modelCapabilities =
    useLastResolved(modelPlanCapabilities$) ?? DEFAULT_MODEL_PLAN_CAPABILITIES;
  if (policiesLoadable.state === "loading") {
    return (
      <LoadingModelFirstModelPickerContent
        value={value}
        placeholder={placeholder}
      />
    );
  }
  if (policiesLoadable.state === "hasError") {
    return (
      <ErrorModelFirstModelPickerContent
        value={value}
        placeholder={placeholder}
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
  });
  return (
    <ModelFirstModelPickerContentLayout
      selectValue={state.selectValue}
      placeholder={placeholder}
      policies={state.policies}
      selectableValue={state.selectableValue}
      modelCapabilities={modelCapabilities}
    />
  );
}

function EnabledExplicitModelFirstModelPicker(
  props: ModelProviderPickerProps & {
    placeholder: string;
    compactTrigger: boolean;
    mobileIconTrigger: boolean;
  },
) {
  const resolveSelection = useSet(resolveExplicitModelSelection$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const state = resolveExplicitModelFirstModelPickerState({
    value: props.value,
    placeholder: props.placeholder,
  });
  const handleRawValueChange = (raw: string) => {
    detach(
      (async () => {
        const result = await resolveSelection(
          {
            selection: modelFirstSelectionFromRaw(raw),
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
          />
        ) : undefined
      }
      placeholder={props.placeholder}
      triggerClassName={props.triggerClassName}
      mobileIconTrigger={props.mobileIconTrigger}
      modelCapabilities={DEFAULT_MODEL_PLAN_CAPABILITIES}
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
}: ModelProviderPickerProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder =
    placeholder ??
    t(($) => {
      return $.settings.models.picker.inheritDefault;
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
  };
  if (resolveDefaultSelection) {
    return <ModelFirstModelPickerWithDefaultSelection {...props} />;
  }
  return <ModelFirstModelPicker {...props} />;
}
