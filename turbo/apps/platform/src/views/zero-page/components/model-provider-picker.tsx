import type { ReactNode } from "react";
import { useLastResolved, useLoadable } from "ccstate-react";
import { IconCpu } from "@tabler/icons-react";
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
  VM0_MODEL_TO_PROVIDER,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies";
import { userModelPreference$ } from "../../../signals/external/user-model-preference";
import { getVm0ModelMultiplier } from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";

const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export interface ModelProviderSelection {
  modelProviderId: string;
  selectedModel: string;
}

interface ModelProviderPickerProps {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
  /**
   * Classes applied to the SelectTrigger. Defaults to `h-9 w-full`. The
   * composer passes an auto-width, compact variant to fit next to Send.
   */
  triggerClassName?: string;
  /**
   * When true, the trigger shows only the friendly model name (no provider
   * label, no multiplier badge). Used by the chat composer where horizontal
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
}

// Radix Select reserves the empty string for "no value" and throws if a
// SelectItem uses it, so use a sentinel to represent the inherit option.
const INHERIT_SENTINEL = "__inherit_default__";

// Radix Select uses the selected item's offsetHeight as the scroll-button
// step. Keep hidden selected items measurable so native hover scrolling works.
const MEASURABLE_HIDDEN_SELECT_ITEM_CLASS =
  "absolute left-0 top-0 h-8 w-px overflow-hidden opacity-0 pointer-events-none";

function formatMultiplier(multiplier: number): string {
  return `×${multiplier}`;
}

function MultiplierBadge({ multiplier }: { multiplier: number }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs tabular-nums text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            {formatMultiplier(multiplier)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Credit cost multiplier
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
          <IconCpu size={18} stroke={1.5} />
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
        !c.startsWith("data-[state=")
      );
    })
    .join(" ");
}

function getModelFirstIconType(model: string): ModelProviderType | undefined {
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
    policies.some((policy) => {
      return (
        policy.model === userPreference.selectedModel &&
        policy.routeStatus === "valid"
      );
    })
      ? {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: userPreference.selectedModel,
        }
      : null;
  const validWorkspaceDefault = policies.find((policy) => {
    return policy.isDefault && policy.routeStatus === "valid";
  });
  return (
    value ??
    validUserDefault ??
    (validWorkspaceDefault
      ? {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: validWorkspaceDefault.model,
        }
      : null)
  );
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
        <span className="truncate">
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
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel: raw,
  };
}

function ModelFirstPolicyRow({ policy }: { policy: OrgModelPolicy }) {
  const iconType = getModelFirstIconType(policy.model);
  const multiplier = getVm0ModelMultiplier(policy.model);
  return (
    <SelectItem
      key={policy.id}
      value={policy.model}
      disabled={policy.routeStatus !== "valid"}
    >
      <span className="flex min-w-0 items-center gap-2">
        {iconType && <ProviderIcon type={iconType} size={16} />}
        <span className="truncate">
          {policy.modelLabel || getCanonicalModelDisplayName(policy.model)}
        </span>
        {multiplier !== undefined && (
          <MultiplierBadge multiplier={multiplier} />
        )}
      </span>
    </SelectItem>
  );
}

function ModelFirstPolicyItems({
  policies,
  explicitSelectedModel,
  showSeparator = true,
}: {
  policies: OrgModelPolicy[];
  explicitSelectedModel: string | null;
  showSeparator?: boolean;
}) {
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
          No configured models
        </div>
      ) : (
        <SelectGroup>
          <SelectLabel className="pl-2 pr-8 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Models
          </SelectLabel>
          {policies.map((policy) => {
            return <ModelFirstPolicyRow key={policy.id} policy={policy} />;
          })}
        </SelectGroup>
      )}
    </>
  );
}

function ModelFirstModelPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  compactTrigger,
  mobileIconTrigger,
  open,
  onOpenChange,
  disabled,
}: ModelProviderPickerProps & {
  placeholder: string;
  compactTrigger: boolean;
  mobileIconTrigger: boolean;
}) {
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const lastPolicies = useLastResolved(orgModelPolicies$);
  const userPreference = useLastResolved(userModelPreference$);
  const policyResponse =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : lastPolicies;
  const policies = policyResponse?.policies ?? [];
  const resolved = resolveModelFirstDefault(value, userPreference, policies);
  const selectedModel = resolved?.selectedModel ?? null;
  const explicitSelectedModel = value?.selectedModel ?? null;
  const selectValue = value?.selectedModel ?? selectedModel ?? INHERIT_SENTINEL;
  const triggerAriaLabel = selectedModel
    ? getCanonicalModelDisplayName(selectedModel)
    : placeholder;

  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={value}
        placeholder={placeholder}
        compactTrigger={compactTrigger}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        userPreference={userPreference}
        policies={policies}
      />
    );
  }

  return (
    <Select
      value={selectValue}
      onValueChange={(raw) => {
        onChange(modelFirstSelectionFromRaw(raw));
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        aria-label={triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerLabel
            selectedModel={selectedModel}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
          />
        </SelectValue>
      </SelectTrigger>
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
          explicitSelectedModel={explicitSelectedModel}
          showSeparator={false}
        />
      </SelectContent>
    </Select>
  );
}

export function ModelProviderPicker({
  value,
  onChange,
  placeholder = "Inherit from org default",
  triggerClassName,
  compactTrigger = false,
  mobileIconTrigger = false,
  open,
  onOpenChange,
  disabled = false,
}: ModelProviderPickerProps) {
  return (
    <ModelFirstModelPicker
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      compactTrigger={compactTrigger}
      mobileIconTrigger={mobileIconTrigger}
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
    />
  );
}
