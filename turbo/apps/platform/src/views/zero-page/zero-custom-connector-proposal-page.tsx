import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { CustomConnectorField } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { toast } from "@vm0/ui/components/ui/sonner";
import { IconCheck, IconLoader2, IconPackage } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import {
  customConnectorProposalAgentName$,
  customConnectorProposalCanSave$,
  customConnectorProposalParams$,
  customConnectorProposalSaved$,
  customConnectorProposalValueMap$,
  saveCustomConnectorProposal$,
  setCustomConnectorProposalFieldValue$,
} from "../../signals/connectors-page/custom-connector-proposal.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Vm0LogoLink } from "./zero-directed-shared.tsx";

function fieldValueId(field: CustomConnectorField): string {
  return `${field.kind}:${field.key}`;
}

function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: CustomConnectorField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = `custom-connector-field-${field.kind}-${field.key}`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {field.label}
        {field.required && <span className="text-primary ml-1">*</span>}
      </label>
      {field.description && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {field.description}
        </p>
      )}
      <Input
        id={id}
        type={field.kind === "secret" ? "password" : "text"}
        value={value}
        disabled={disabled}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

function ConnectorDefinitionPreview({
  prefixes,
  notes,
}: {
  prefixes: readonly string[];
  notes: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-muted/50 px-3 py-3 text-left">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {t(($) => {
          return $.connectors.customProposal.requestScope;
        })}
      </div>
      <div className="flex flex-col gap-1">
        {prefixes.map((prefix) => {
          return (
            <code
              key={prefix}
              className="break-all rounded-md bg-background px-2 py-1 font-mono text-xs text-foreground"
            >
              {prefix}
            </code>
          );
        })}
      </div>
      {notes && (
        <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
          {notes}
        </p>
      )}
    </div>
  );
}

function ProposalStatusCard({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-6 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <Vm0LogoLink />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function ProposalSaveControl({
  saved,
  saving,
  canSave,
  onSave,
}: {
  saved: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex w-full items-center justify-center">
        {saved ? (
          <div className="inline-flex h-9 items-center justify-center gap-1.5 text-sm font-medium text-emerald-600">
            <IconCheck size={16} />
            {t(($) => {
              return $.connectors.customProposal.saved;
            })}
          </div>
        ) : (
          <Button
            className="min-w-[140px]"
            onClick={onSave}
            disabled={!canSave}
          >
            {saving && <IconLoader2 size={14} className="animate-spin" />}
            {saving
              ? t(($) => {
                  return $.connectors.actions.saving;
                })
              : t(($) => {
                  return $.connectors.actions.save;
                })}
          </Button>
        )}
      </div>

      {saved && (
        <p className="w-72 max-w-full text-xs leading-relaxed text-muted-foreground">
          {t(($) => {
            return $.connectors.customProposal.returnToChat;
          })}
        </p>
      )}
    </>
  );
}

function CustomConnectorProposalCard() {
  const { t } = useTranslation();
  const params = useGet(customConnectorProposalParams$);
  const agentNameLoadable = useLastLoadable(customConnectorProposalAgentName$);
  const valueMap = useGet(customConnectorProposalValueMap$);
  const saved = useGet(customConnectorProposalSaved$);
  const hasRequiredFields = useGet(customConnectorProposalCanSave$);
  const pageSignal = useGet(pageSignal$);
  const setFieldValue = useSet(setCustomConnectorProposalFieldValue$);
  const [saveLoadable, saveProposal] = useLoadableSet(
    saveCustomConnectorProposal$,
  );

  if (!params) {
    return (
      <ProposalStatusCard
        message={t(($) => {
          return $.connectors.customProposal.invalid;
        })}
      />
    );
  }

  const { proposal, agentId } = params;
  const agentName =
    agentNameLoadable.state === "hasData" && agentNameLoadable.data
      ? agentNameLoadable.data
      : t(($) => {
          return $.connectors.customProposal.targetFallback;
        });
  const saving = saveLoadable.state === "loading";
  const canSave = !saving && hasRequiredFields;
  const title =
    proposal.operation === "create"
      ? t(
          ($) => {
            return $.connectors.customProposal.configure;
          },
          { connector: proposal.displayName },
        )
      : t(
          ($) => {
            return $.connectors.customProposal.update;
          },
          { connector: proposal.displayName },
        );

  const onSave = () => {
    if (!canSave) {
      return;
    }
    detach(
      (async () => {
        const result = await saveProposal(pageSignal);
        toast.success(
          i18n.t(
            ($) => {
              return $.connectors.customProposal.savedToast;
            },
            { connector: result.connector.displayName },
          ),
        );
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center overflow-y-auto px-4 py-8">
      <div className="flex w-[480px] max-w-full flex-col items-center gap-8 rounded-[20px] border border-border bg-background px-6 py-8 text-center">
        <Vm0LogoLink />
        <div className="flex w-full flex-col items-center gap-4">
          <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
            <IconPackage size={20} className="text-foreground" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-medium text-foreground">{title}</h1>
            <p className="mx-auto w-72 max-w-full text-sm text-muted-foreground">
              {agentId
                ? t(
                    ($) => {
                      return $.connectors.customProposal.descriptionAgent;
                    },
                    { agent: agentName },
                  )
                : t(($) => {
                    return $.connectors.customProposal.descriptionUser;
                  })}
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-5">
          <ConnectorDefinitionPreview
            prefixes={proposal.prefixTemplates}
            notes={proposal.notes}
          />
          <div className="flex flex-col gap-4 text-left">
            {proposal.fields.map((field) => {
              const id = fieldValueId(field);
              return (
                <FieldInput
                  key={id}
                  field={field}
                  value={valueMap[id] ?? ""}
                  disabled={saving || saved}
                  onChange={(value) => {
                    setFieldValue(field, value);
                  }}
                />
              );
            })}
          </div>
        </div>

        <ProposalSaveControl
          saved={saved}
          saving={saving}
          canSave={canSave}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

export function ZeroCustomConnectorProposalPage() {
  return <CustomConnectorProposalCard />;
}
