import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import type {
  UsagePackCatalogItem,
  UsagePackChangePreviewResponse,
  UsagePackManagementResponse,
  UsagePackUsd,
} from "@vm0/api-contracts/contracts/zero-billing";
import { useGet, useLoadable, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";

import { currentUserInfo$ } from "../../../../signals/auth.ts";
import { orgMembers$ } from "../../../../signals/external/org-members.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeUsagePackChangePreview$,
  confirmUsagePackChange$,
  previewUsagePackChange$,
  reloadUsagePackManagement$,
  setUsagePackChangeSelection$,
  usagePackCatalogAsync$,
  usagePackChangePreview$,
  usagePackChangeSelections$,
  usagePackManagementAsync$,
} from "../../../../signals/zero-page/billing.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";

type ManagedAllocation = UsagePackManagementResponse["allocations"][number];

interface UsagePackMemberName {
  readonly userId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string;
}

interface CurrentUsagePackUserName {
  readonly id: string;
  readonly fullName: string | null;
  readonly primaryEmailAddress: { readonly emailAddress: string } | null;
}

function usagePackMemberNames(
  members: readonly UsagePackMemberName[],
  user: CurrentUsagePackUserName | undefined,
): ReadonlyMap<string, string> {
  const names = new Map(
    members.map((member) => {
      const name =
        [member.firstName, member.lastName].filter(Boolean).join(" ") ||
        member.email;
      return [member.userId, name] as const;
    }),
  );
  if (user) {
    names.set(
      user.id,
      user.fullName ?? user.primaryEmailAddress?.emailAddress ?? user.id,
    );
  }
  return names;
}

function usagePackOption(item: UsagePackCatalogItem): string {
  const discount = Math.round((item.bonusCredits / item.totalCredits) * 100);
  return i18n.t(
    ($) => {
      return $.billing.plans.usagePacks.packOption;
    },
    {
      credits: formatLocalizedNumber(item.totalCredits),
      discount,
      price: formatUsd(item.priceUsd, 0),
    },
  );
}

function formatEffectiveDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function pendingChangeLabel(allocation: ManagedAllocation): string | null {
  const pending = allocation.pendingChange;
  if (!pending) {
    return null;
  }
  const effectiveDate = formatEffectiveDate(pending.effectiveAt);
  if (pending.status === "scheduled" && effectiveDate) {
    return i18n.t(
      ($) => {
        return $.billing.plans.usagePacks.management.scheduledFor;
      },
      { date: effectiveDate },
    );
  }
  if (pending.status === "pending_payment") {
    return i18n.t(($) => {
      return $.billing.plans.usagePacks.management.awaitingPayment;
    });
  }
  return i18n.t(($) => {
    return $.billing.plans.usagePacks.management.processing;
  });
}

function ManagedUsagePackRow({
  allocation,
  catalog,
  disabled,
  memberName,
  onPreview,
  onTargetChange,
  target,
}: {
  readonly allocation: ManagedAllocation;
  readonly catalog: readonly UsagePackCatalogItem[];
  readonly disabled: boolean;
  readonly memberName: string;
  readonly onPreview: (target: UsagePackUsd) => void;
  readonly onTargetChange: (target: UsagePackUsd) => void;
  readonly target: UsagePackUsd;
}) {
  const pendingLabel = pendingChangeLabel(allocation);
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {memberName}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {pendingLabel ??
            i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.management.currentPackage;
              },
              { price: formatUsd(allocation.usagePackUsd, 0) },
            )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Select
          disabled={disabled || allocation.pendingChange !== null}
          value={String(target)}
          onValueChange={(value) => {
            const next = catalog.find((item) => {
              return String(item.usagePackUsd) === value;
            })?.usagePackUsd;
            if (next !== undefined) {
              onTargetChange(next);
            }
          }}
        >
          <SelectTrigger
            className="h-9 w-[230px]"
            aria-label={i18n.t(
              ($) => {
                return $.billing.plans.usagePacks.selectUsage;
              },
              { name: memberName },
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {catalog.map((item) => {
              return (
                <SelectItem
                  key={item.usagePackUsd}
                  value={String(item.usagePackUsd)}
                >
                  {usagePackOption(item)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9"
          disabled={
            disabled ||
            allocation.pendingChange !== null ||
            target === allocation.usagePackUsd
          }
          onClick={() => {
            onPreview(target);
          }}
        >
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.management.review;
          })}
        </Button>
      </div>
    </div>
  );
}

function UsagePackChangeDialog({
  confirming,
  error,
  onClose,
  onConfirm,
  preview,
}: {
  readonly confirming: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly preview: UsagePackChangePreviewResponse | null;
}) {
  const effectiveDate = formatEffectiveDate(preview?.effectiveAt ?? null);
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.plans.usagePacks.management.reviewTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {preview?.kind === "upgrade"
              ? i18n.t(($) => {
                  return $.billing.plans.usagePacks.management
                    .upgradeDescription;
                })
              : i18n.t(($) => {
                  return $.billing.plans.usagePacks.management
                    .downgradeDescription;
                })}
          </DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="flex flex-col gap-3 rounded-xl bg-muted/30 p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {i18n.t(($) => {
                  return $.billing.plans.usagePacks.management.immediateAmount;
                })}
              </span>
              <span className="font-medium text-foreground">
                {formatUsd(preview.immediateAmountCents / 100, 2)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {i18n.t(($) => {
                  return $.billing.plans.usagePacks.management.nextRecurring;
                })}
              </span>
              <span className="font-medium text-foreground">
                {formatUsd(preview.nextRecurringAmountCents / 100, 2)}
              </span>
            </div>
            {effectiveDate && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">
                  {i18n.t(($) => {
                    return $.billing.plans.usagePacks.management.effectiveDate;
                  })}
                </span>
                <span className="font-medium text-foreground">
                  {effectiveDate}
                </span>
              </div>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={confirming} onClick={onClose}>
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button disabled={confirming} onClick={onConfirm}>
            {confirming
              ? i18n.t(($) => {
                  return $.billing.plans.usagePacks.management.confirming;
                })
              : i18n.t(($) => {
                  return $.billing.common.confirm;
                })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function UsagePackManagementSection() {
  const pageSignal = useGet(pageSignal$);
  const managementLoadable = useLoadable(usagePackManagementAsync$);
  const catalogLoadable = useLoadable(usagePackCatalogAsync$);
  const membersLoadable = useLoadable(orgMembers$);
  const userLoadable = useLastLoadable(currentUserInfo$);
  const reload = useSet(reloadUsagePackManagement$);
  const preview = useGet(usagePackChangePreview$);
  const selections = useGet(usagePackChangeSelections$);
  const closePreview = useSet(closeUsagePackChangePreview$);
  const setSelection = useSet(setUsagePackChangeSelection$);
  const [previewLoadable, previewChange] = useLoadableSet(
    previewUsagePackChange$,
  );
  const [confirmLoadable, confirmChange] = useLoadableSet(
    confirmUsagePackChange$,
  );
  const management =
    managementLoadable.state === "hasData" ? managementLoadable.data : null;
  const catalog =
    catalogLoadable.state === "hasData" ? catalogLoadable.data : null;
  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const memberNames = usagePackMemberNames(members, user);
  if (managementLoadable.state === "hasData" && management === null) {
    return null;
  }
  const loading =
    managementLoadable.state === "loading" ||
    catalogLoadable.state === "loading";
  const loadError =
    managementLoadable.state === "hasError" ||
    catalogLoadable.state === "hasError";
  const previewing = previewLoadable.state === "loading";
  const confirming = confirmLoadable.state === "loading";
  const error =
    previewLoadable.state === "hasError" || confirmLoadable.state === "hasError"
      ? i18n.t(($) => {
          return $.billing.plans.usagePacks.management.changeError;
        })
      : null;
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.management.title;
          })}
        </h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.usagePacks.management.description;
          })}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl bg-card zero-border">
        {loadError ? (
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <p className="text-sm text-muted-foreground">
              {i18n.t(($) => {
                return $.billing.plans.usagePacks.management.loadError;
              })}
            </p>
            <Button variant="outline" size="sm" onClick={reload}>
              {i18n.t(($) => {
                return $.billing.common.retry;
              })}
            </Button>
          </div>
        ) : loading || !management || !catalog ? (
          <div className="h-20 animate-pulse bg-muted/30" />
        ) : (
          management.allocations.map((allocation, index) => {
            return (
              <div key={allocation.id}>
                {index > 0 && <div className="h-0 zero-border-t mx-5" />}
                <ManagedUsagePackRow
                  allocation={allocation}
                  catalog={catalog}
                  disabled={previewing || confirming}
                  memberName={
                    memberNames.get(allocation.memberId) ?? allocation.memberId
                  }
                  target={selections[allocation.id] ?? allocation.usagePackUsd}
                  onTargetChange={(target) => {
                    setSelection(allocation.id, target);
                  }}
                  onPreview={(targetUsagePackUsd) => {
                    detach(
                      previewChange(
                        {
                          memberId: allocation.memberId,
                          targetUsagePackUsd,
                        },
                        pageSignal,
                      ),
                      Reason.DomCallback,
                    );
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      {error && !preview && <p className="text-sm text-destructive">{error}</p>}
      <UsagePackChangeDialog
        confirming={confirming}
        error={error}
        preview={preview}
        onClose={() => {
          closePreview();
        }}
        onConfirm={() => {
          if (preview) {
            detach(
              confirmChange(preview.changeId, pageSignal),
              Reason.DomCallback,
            );
          }
        }}
      />
    </section>
  );
}
