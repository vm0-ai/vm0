// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconDotsVertical,
  IconKey,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import {
  SUPPORTED_RUN_MODELS,
  getCanonicalModelDisplayName,
  getProvidersForModel,
  type ModelProviderResponse,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  orgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../../../signals/external/org-model-policies.ts";
import {
  orgConfiguredProviders$,
  orgOpenAddDialogForModelPolicyRoute$,
  orgOpenEditDialog$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import {
  closeModelPolicyDialog$,
  modelPolicyDialogState$,
  openAddModelPolicyDialog$,
  openEditModelPolicyDialog$,
  updateModelPolicyDialogModel$,
  updateModelPolicyDialogRoute$,
  type ModelPolicyDialogMode,
  type ModelPolicyRouteKind,
} from "../../../../signals/zero-page/settings/org-model-policy-dialog.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  getUILabel,
  getVm0ModelMultiplier,
} from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";

function isOAuthMemberType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function isByokProviderType(type: ModelProviderType): boolean {
  return type !== "vm0" && !isOAuthMemberType(type);
}

function getModelIconType(model: SupportedRunModel): ModelProviderType | null {
  const compatibleTypes = getProvidersForModel(model);
  return (
    compatibleTypes.find((type) => {
      return type !== "vm0" && !isOAuthMemberType(type);
    }) ??
    compatibleTypes.find((type) => {
      return type !== "vm0";
    }) ??
    null
  );
}

function getApiProviderTypes(model: SupportedRunModel): ModelProviderType[] {
  return getProvidersForModel(model).filter((type) => {
    return isByokProviderType(type);
  });
}

function getOAuthProviderTypes(model: SupportedRunModel): ModelProviderType[] {
  return getProvidersForModel(model).filter((type) => {
    return isOAuthMemberType(type);
  });
}

function findProviderByType(
  providers: ModelProviderResponse[],
  type: ModelProviderType | null,
): ModelProviderResponse | null {
  if (!type) {
    return null;
  }
  return (
    providers.find((provider) => {
      return provider.type === type;
    }) ?? null
  );
}

function toUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
  return {
    model: policy.model,
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
  };
}

function makeDefaultPolicy(
  model: SupportedRunModel,
  isDefault: boolean,
): UpdateOrgModelPolicy {
  return {
    model,
    isDefault,
    defaultProviderType: "vm0",
    credentialScope: "org",
    modelProviderId: null,
  };
}

function upsertPolicy(
  policies: OrgModelPolicy[],
  update: UpdateOrgModelPolicy,
): UpdateOrgModelPolicy[] {
  let found = false;
  const updates = policies.map((policy) => {
    if (policy.model !== update.model) {
      return toUpdate(policy);
    }
    found = true;
    return update;
  });
  if (!found) {
    updates.push(update);
  }
  return updates;
}

function removePolicy(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
): UpdateOrgModelPolicy[] {
  const removed = policies.find((policy) => {
    return policy.model === model;
  });
  const updates = policies.flatMap((policy) => {
    return policy.model === model ? [] : [toUpdate(policy)];
  });
  if (
    removed?.isDefault &&
    !updates.some((policy) => {
      return policy.isDefault;
    }) &&
    updates[0]
  ) {
    return updates.map((policy, index) => {
      return { ...policy, isDefault: index === 0 };
    });
  }
  return updates;
}

function makePolicyDefault(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
): UpdateOrgModelPolicy[] {
  const selected = policies.find((policy) => {
    return policy.model === model;
  });
  if (!selected) {
    return policies.map(toUpdate);
  }
  return policies.map((policy) => {
    return {
      ...toUpdate(policy),
      isDefault: policy.model === model,
    };
  });
}

function DefaultModelSection({
  policies,
  workspaceDefaultModel,
  disabled,
  onChange,
}: {
  policies: OrgModelPolicy[];
  workspaceDefaultModel: SupportedRunModel | null;
  disabled: boolean;
  onChange: (model: SupportedRunModel) => void;
}) {
  const selectItems = policies.filter((policy) => {
    return policy.routeStatus === "valid";
  });
  const currentDefault = selectItems.some((policy) => {
    return policy.model === workspaceDefaultModel;
  })
    ? (workspaceDefaultModel ?? "")
    : "";

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Default</h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Default model</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Applied to workspace tasks that do not pick a model.
            </p>
          </div>
          {selectItems.length === 0 ? (
            <span className="shrink-0 text-sm text-muted-foreground">
              No available models
            </span>
          ) : (
            <Select
              value={currentDefault}
              onValueChange={(value) => {
                onChange(value as SupportedRunModel);
              }}
              disabled={disabled}
            >
              <SelectTrigger
                className="h-9 w-full shrink-0 rounded-lg sm:w-[280px]"
                style={{ border: "0.7px solid hsl(var(--gray-400))" }}
              >
                <SelectValue placeholder="Select a default model" />
              </SelectTrigger>
              <SelectContent>
                {selectItems.map((policy) => {
                  const iconType = getModelIconType(policy.model);
                  return (
                    <SelectItem key={policy.id} value={policy.model}>
                      <div className="flex items-center gap-2">
                        {iconType && <ProviderIcon type={iconType} size={16} />}
                        <span>{policy.modelLabel}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </section>
  );
}

function getPolicyDetail(policy: OrgModelPolicy): string | null {
  if (policy.routeStatusReason) {
    return policy.routeStatusReason;
  }
  return null;
}

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

function getSelectedByokProvider(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
): ModelProviderResponse | null {
  if (
    policy.credentialScope !== "org" ||
    !isByokProviderType(policy.defaultProviderType) ||
    !policy.modelProviderId
  ) {
    return null;
  }
  return (
    providers.find((provider) => {
      return provider.id === policy.modelProviderId;
    }) ?? null
  );
}

function getPolicyRouteSummary(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
): { label: string; iconType: ModelProviderType } {
  if (policy.defaultProviderType === "vm0") {
    return {
      label: "Built-in",
      iconType: "vm0",
    };
  }

  const orgProvider = getSelectedByokProvider(policy, providers);
  if (orgProvider) {
    return {
      label: getUILabel(orgProvider.type),
      iconType: orgProvider.type,
    };
  }
  if (
    policy.credentialScope === "member" &&
    isOAuthMemberType(policy.defaultProviderType)
  ) {
    return {
      label: getUILabel(policy.defaultProviderType),
      iconType: policy.defaultProviderType,
    };
  }

  return {
    label: getUILabel(policy.defaultProviderType),
    iconType: policy.defaultProviderType,
  };
}

function PolicyActionsMenu({
  policy,
  disabled,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: OrgModelPolicy;
  disabled: boolean;
  canDelete: boolean;
  onEdit: (policy: OrgModelPolicy) => void;
  onDelete: (policy: OrgModelPolicy) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label={`Actions for ${policy.modelLabel}`}
        >
          <IconDotsVertical size={14} stroke={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            onEdit(policy);
          }}
        >
          <IconPencil size={14} stroke={1.5} />
          Edit model
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={disabled || !canDelete}
          onSelect={() => {
            onDelete(policy);
          }}
        >
          <IconTrash size={14} stroke={1.5} />
          Delete model
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddModelButton({
  hasModels,
  disabled,
  onClick,
}: {
  hasModels: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  if (!hasModels) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="h-8 gap-2 rounded-lg px-3 text-sm"
      disabled={disabled}
      onClick={onClick}
    >
      <IconPlus size={14} stroke={1.8} />
      Add model
    </Button>
  );
}

function PolicyRow({
  policy,
  providers,
  disabled,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: OrgModelPolicy;
  providers: ModelProviderResponse[];
  disabled: boolean;
  canDelete: boolean;
  onEdit: (policy: OrgModelPolicy) => void;
  onDelete: (policy: OrgModelPolicy) => void;
}) {
  const detail = getPolicyDetail(policy);
  const routeSummary = getPolicyRouteSummary(policy, providers);
  const modelIconType = getModelIconType(policy.model);
  const builtInMultiplier =
    policy.defaultProviderType === "vm0"
      ? getVm0ModelMultiplier(policy.model)
      : undefined;

  return (
    <div
      data-testid={`org-model-policy-row-${policy.model}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_236px_auto]"
    >
      <div className="flex min-w-0 flex-col justify-center">
        <div className="flex items-center gap-2">
          {modelIconType && <ProviderIcon type={modelIconType} size={18} />}
          <p className="truncate text-sm font-medium text-foreground">
            {policy.modelLabel}
          </p>
          {builtInMultiplier !== undefined && (
            <MultiplierBadge multiplier={builtInMultiplier} />
          )}
          {policy.routeStatus !== "valid" && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <IconAlertTriangle size={12} />
              {policy.routeStatus === "missing_provider"
                ? "Missing provider"
                : "Invalid route"}
            </span>
          )}
        </div>
        {detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end sm:order-4">
        <PolicyActionsMenu
          policy={policy}
          disabled={disabled}
          canDelete={canDelete}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
      <div className="col-span-2 flex min-w-0 flex-col justify-center sm:order-3 sm:col-span-1 sm:items-start">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <ProviderIcon type={routeSummary.iconType} size={16} />
          <span className="min-w-0 truncate">{routeSummary.label}</span>
        </div>
      </div>
    </div>
  );
}

function RouteChoiceButton({
  active,
  disabled = false,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-[88px] items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-background/40 hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-50 hover:bg-background/40",
      )}
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function ProviderTypeSelect({
  value,
  types,
  providers,
  placeholder,
  configuredLabel,
  missingLabel,
  onChange,
}: {
  value: ModelProviderType | null;
  types: ModelProviderType[];
  providers: ModelProviderResponse[];
  placeholder: string;
  configuredLabel?: string;
  missingLabel?: string;
  onChange: (type: ModelProviderType) => void;
}) {
  if (types.length === 0) {
    return null;
  }

  return (
    <Select
      value={value ?? undefined}
      onValueChange={(next) => {
        onChange(next as ModelProviderType);
      }}
    >
      <SelectTrigger className="h-10 rounded-lg">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {types.map((type) => {
          const configured = Boolean(findProviderByType(providers, type));
          return (
            <SelectItem key={type} value={type}>
              <div className="flex min-w-0 items-center gap-2">
                <ProviderIcon type={type} size={16} />
                <span className="min-w-0 flex-1 truncate">
                  {getUILabel(type)}
                </span>
                {configuredLabel && missingLabel && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {configured ? configuredLabel : missingLabel}
                  </span>
                )}
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function buildPolicyUpdate(params: {
  policies: OrgModelPolicy[];
  model: SupportedRunModel;
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  provider: ModelProviderResponse | null;
}): UpdateOrgModelPolicy | null {
  const existing = params.policies.find((policy) => {
    return policy.model === params.model;
  });
  const base = existing
    ? toUpdate(existing)
    : makeDefaultPolicy(params.model, params.policies.length === 0);

  if (params.routeKind === "built-in") {
    return {
      ...base,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
    };
  }

  if (!params.providerType) {
    return null;
  }

  if (params.routeKind === "oauth") {
    return {
      ...base,
      defaultProviderType: params.providerType,
      credentialScope: "member",
      modelProviderId: null,
    };
  }

  if (!params.provider) {
    return null;
  }

  return {
    ...base,
    defaultProviderType: params.provider.type,
    credentialScope: "org",
    modelProviderId: params.provider.id,
  };
}

function getDialogPrimaryLabel(params: {
  mode: ModelPolicyDialogMode;
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  provider: ModelProviderResponse | null;
}): string {
  if (
    params.routeKind === "api-key" &&
    params.providerType &&
    !params.provider
  ) {
    return `Add ${getUILabel(params.providerType)} API key`;
  }
  return params.mode === "add" ? "Add model" : "Save changes";
}

function getDefaultProviderTypeForRoute(params: {
  routeKind: ModelPolicyRouteKind;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
}): ModelProviderType | null {
  if (params.routeKind === "api-key") {
    return params.apiTypes[0] ?? null;
  }
  if (params.routeKind === "oauth") {
    return params.oauthTypes[0] ?? null;
  }
  return null;
}

function getSelectedProviderType(params: {
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
}): ModelProviderType | null {
  if (params.routeKind === "api-key") {
    return params.providerType && params.apiTypes.includes(params.providerType)
      ? params.providerType
      : (params.apiTypes[0] ?? null);
  }
  if (params.routeKind === "oauth") {
    return params.providerType &&
      params.oauthTypes.includes(params.providerType)
      ? params.providerType
      : (params.oauthTypes[0] ?? null);
  }
  return null;
}

function getSelectedRouteProvider(params: {
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  providers: ModelProviderResponse[];
}): ModelProviderResponse | null {
  if (params.routeKind === "api-key") {
    return findProviderByType(params.providers, params.providerType);
  }
  return null;
}

function ModelPolicyRouteDialog({
  policies,
  addableModels,
  providers,
  saving,
  onSubmit,
}: {
  policies: OrgModelPolicy[];
  addableModels: SupportedRunModel[];
  providers: ModelProviderResponse[];
  saving: boolean;
  onSubmit: (next: UpdateOrgModelPolicy[]) => void;
}) {
  const dialog = useGet(modelPolicyDialogState$);
  const close = useSet(closeModelPolicyDialog$);
  const setModel = useSet(updateModelPolicyDialogModel$);
  const setRoute = useSet(updateModelPolicyDialogRoute$);
  const openAddProvider = useSet(orgOpenAddDialogForModelPolicyRoute$);
  const openEditProvider = useSet(orgOpenEditDialog$);
  const selectedModel = dialog.model ?? addableModels[0] ?? null;
  const apiTypes = selectedModel ? getApiProviderTypes(selectedModel) : [];
  const oauthTypes = selectedModel ? getOAuthProviderTypes(selectedModel) : [];
  const selectedProviderType = getSelectedProviderType({
    routeKind: dialog.routeKind,
    providerType: dialog.providerType,
    apiTypes,
    oauthTypes,
  });
  const routeProvider = getSelectedRouteProvider({
    routeKind: dialog.routeKind,
    providerType: selectedProviderType,
    providers,
  });
  const selectedModelIcon = selectedModel
    ? getModelIconType(selectedModel)
    : null;

  const chooseRoute = (routeKind: ModelPolicyRouteKind) => {
    setRoute({
      routeKind,
      providerType: getDefaultProviderTypeForRoute({
        routeKind,
        apiTypes,
        oauthTypes,
      }),
    });
  };

  const handleSubmit = () => {
    if (!selectedModel || saving) {
      return;
    }

    if (
      dialog.routeKind === "api-key" &&
      selectedProviderType &&
      !routeProvider
    ) {
      openAddProvider({
        model: selectedModel,
        providerType: selectedProviderType,
      });
      return;
    }

    const update = buildPolicyUpdate({
      policies,
      model: selectedModel,
      routeKind: dialog.routeKind,
      providerType: selectedProviderType,
      provider: routeProvider,
    });
    if (!update) {
      return;
    }
    onSubmit(upsertPolicy(policies, update));
    close();
  };

  const handleEditCredential = () => {
    if (!selectedModel || !selectedProviderType || !routeProvider) {
      return;
    }
    if (dialog.routeKind === "api-key") {
      openEditProvider(routeProvider);
    }
  };

  const primaryLabel = getDialogPrimaryLabel({
    mode: dialog.mode,
    routeKind: dialog.routeKind,
    providerType: selectedProviderType,
    provider: routeProvider,
  });
  const submitDisabled =
    !selectedModel ||
    saving ||
    (dialog.routeKind !== "built-in" && !selectedProviderType);

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {dialog.mode === "add" ? "Add model" : "Edit model route"}
          </DialogTitle>
          <DialogDescription>
            Choose the model members can select and decide whether it uses VM0
            credits or your own provider credentials.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {dialog.mode === "add" ? (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">
                Model
              </label>
              <Select
                value={selectedModel ?? undefined}
                onValueChange={(next) => {
                  setModel(next as SupportedRunModel);
                }}
              >
                <SelectTrigger className="h-10 rounded-lg">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {addableModels.map((model) => {
                    const iconType = getModelIconType(model);
                    return (
                      <SelectItem key={model} value={model}>
                        <div className="flex items-center gap-2">
                          {iconType && (
                            <ProviderIcon type={iconType} size={16} />
                          )}
                          <span>{getCanonicalModelDisplayName(model)}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-background/40 p-3">
              {selectedModelIcon && (
                <ProviderIcon type={selectedModelIcon} size={18} />
              )}
              <span className="text-sm font-medium text-foreground">
                {selectedModel
                  ? getCanonicalModelDisplayName(selectedModel)
                  : "Unknown model"}
              </span>
            </div>
          )}

          <div className="grid gap-3">
            <RouteChoiceButton
              active={dialog.routeKind === "built-in"}
              icon={<ProviderIcon type="vm0" size={18} />}
              title="Built-in"
              description="Uses VM0 managed keys and workspace credits. No setup is required for members."
              onClick={() => {
                chooseRoute("built-in");
              }}
            />
            <RouteChoiceButton
              active={dialog.routeKind === "api-key"}
              disabled={apiTypes.length === 0}
              icon={<IconKey size={18} stroke={1.6} />}
              title="BYOK: workspace API key"
              description="An admin adds one provider API key for the workspace. Every member can use this route without adding personal credentials."
              onClick={() => {
                chooseRoute("api-key");
              }}
            />
            {oauthTypes.length > 0 && (
              <RouteChoiceButton
                active={dialog.routeKind === "oauth"}
                icon={<IconUsers size={18} stroke={1.6} />}
                title="BYOK: member OAuth"
                description="Admins enable the OAuth route for this model. Each member uses their own credentials configured outside this dialog."
                onClick={() => {
                  chooseRoute("oauth");
                }}
              />
            )}
          </div>

          {dialog.routeKind === "api-key" && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">
                Workspace API provider
              </label>
              <ProviderTypeSelect
                value={selectedProviderType}
                types={apiTypes}
                providers={providers}
                placeholder="Select API provider"
                configuredLabel="Configured"
                missingLabel="Needs API key"
                onChange={(providerType) => {
                  setRoute({ routeKind: "api-key", providerType });
                }}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                API key routes are shared workspace credentials. They are best
                when the team should run through one billing account or one
                centrally managed key.
              </p>
            </div>
          )}

          {routeProvider && dialog.routeKind === "api-key" && (
            <Button
              type="button"
              variant="outline"
              className="w-fit gap-2 rounded-lg"
              onClick={handleEditCredential}
            >
              <IconPencil size={14} stroke={1.5} />
              Edit API key
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrgModelPoliciesSection() {
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const lastPolicies = useLastResolved(orgModelPolicies$);
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const lastProviders = useLastResolved(orgConfiguredProviders$);
  const pageSignal = useGet(pageSignal$);
  const openAddModelDialog = useSet(openAddModelPolicyDialog$);
  const openEditModelDialog = useSet(openEditModelPolicyDialog$);
  const [updateLoadable, updatePolicies] = useLoadableSet(
    updateOrgModelPolicies$,
  );
  const saving = updateLoadable.state === "loading";

  const data =
    policiesLoadable.state === "hasData" ? policiesLoadable.data : lastPolicies;
  const providers =
    providersLoadable.state === "hasData"
      ? providersLoadable.data
      : (lastProviders ?? []);
  const providersReady =
    providersLoadable.state === "hasData" || lastProviders !== undefined;

  if (
    (!data && policiesLoadable.state === "loading") ||
    (!providersReady && providersLoadable.state === "loading")
  ) {
    return <ModelPoliciesSkeleton />;
  }

  if (!data) {
    return null;
  }

  const policies = data.policies;
  const visiblePolicies = policies.filter((policy) => {
    return SUPPORTED_RUN_MODELS.includes(policy.model);
  });
  const configuredModels = new Set(
    policies.map((policy) => {
      return policy.model;
    }),
  );
  const addableModels = SUPPORTED_RUN_MODELS.filter((model) => {
    return !configuredModels.has(model);
  });

  const submit = (next: UpdateOrgModelPolicy[]) => {
    detach(updatePolicies({ policies: next }, pageSignal), Reason.DomCallback);
  };
  const handleDefaultModelChange = (model: SupportedRunModel) => {
    if (saving || model === data.workspaceDefaultModel) {
      return;
    }
    submit(makePolicyDefault(policies, model));
  };
  const handleOpenAddModel = () => {
    if (saving) {
      return;
    }
    openAddModelDialog(addableModels[0] ?? null);
  };
  const handleEditPolicy = (policy: OrgModelPolicy) => {
    if (saving) {
      return;
    }
    openEditModelDialog(policy);
  };
  const handleDeletePolicy = (policy: OrgModelPolicy) => {
    if (saving || policies.length <= 1) {
      return;
    }
    submit(removePolicy(policies, policy.model));
  };

  return (
    <div className="flex flex-col gap-8">
      <DefaultModelSection
        policies={visiblePolicies}
        workspaceDefaultModel={data.workspaceDefaultModel}
        disabled={saving}
        onChange={handleDefaultModelChange}
      />
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-foreground">Models</h3>
          <AddModelButton
            hasModels={addableModels.length > 0}
            disabled={saving}
            onClick={handleOpenAddModel}
          />
        </div>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          <div className="divide-y divide-border/50">
            {visiblePolicies.map((policy) => {
              return (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  providers={providers}
                  disabled={false}
                  canDelete={policies.length > 1}
                  onEdit={handleEditPolicy}
                  onDelete={handleDeletePolicy}
                />
              );
            })}
          </div>
        </div>
      </section>
      <ModelPolicyRouteDialog
        policies={policies}
        addableModels={addableModels}
        providers={providers}
        saving={saving}
        onSubmit={submit}
      />
    </div>
  );
}

function ModelPoliciesSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <div className="h-5 w-24 rounded bg-muted/50 animate-pulse" />
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        {[0, 1, 2].map((item) => {
          return (
            <div key={item} className="flex h-16 items-center gap-3 px-4">
              <div className="h-5 w-9 rounded-full bg-muted/50 animate-pulse" />
              <div className="h-4 w-40 rounded bg-muted/50 animate-pulse" />
            </div>
          );
        })}
      </div>
    </section>
  );
}
