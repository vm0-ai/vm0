import { useGet, useSet } from "ccstate-react";
import { IconScanEye } from "@tabler/icons-react";
import {
  onboardingDraft$,
  onboardingUi$,
  updateOnboardingDraft$,
  updateOnboardingUi$,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  OnboardingConnectorSetup,
  useRequiredConnectorsState,
} from "./onboarding-connectors.tsx";
import {
  buildCustomWorkflowPrompt,
  buildWorkflowPrompt,
  CUSTOM_WORKFLOW_ID,
  findOnboardingWorkflow,
} from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingRunAction } from "./onboarding-run-action.tsx";
import { OnboardingShell } from "./onboarding-shell.tsx";
import {
  WorkflowConnectorPills,
  WorkflowPreview,
} from "./onboarding-workflow-picker-page.tsx";

function formatConnectorList(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function OnboardingWorkflowRunPage() {
  const draft = useGet(onboardingDraft$);
  const ui = useGet(onboardingUi$);
  const setDraft = useSet(updateOnboardingDraft$);
  const setUi = useSet(updateOnboardingUi$);
  const { navigateTo } = useOnboardingNavigation();
  const custom = draft.workflowId === CUSTOM_WORKFLOW_ID;
  const workflow = findOnboardingWorkflow(draft.workflowId);
  const requiredState = useRequiredConnectorsState(workflow?.required ?? []);
  const requiredConnectorsMissing =
    (workflow?.required.length ?? 0) > 0 && !requiredState.allConnected;
  const previewOpen = ui.workflowPreviewId === workflow?.id;
  const prompt = custom
    ? buildCustomWorkflowPrompt(draft.workflowNote)
    : workflow
      ? buildWorkflowPrompt(workflow, draft.workflowNote)
      : "";

  const handleBack = (): void => {
    navigateTo(ROUTES.onboardingWorkflowPicker, {
      updates: {
        choice: "workflow",
        category: draft.categoryId,
        workflow: draft.workflowId,
      },
    });
  };

  const title =
    workflow && workflow.connectors.length > 0
      ? "Connect your tools and customize your workflow"
      : "Customize your workflow";

  return (
    <>
      <OnboardingShell
        currentStep={3}
        totalSteps={3}
        title={title}
        description=""
        footer={
          <OnboardingRunAction
            prompt={prompt}
            disabled={
              (custom && !draft.workflowNote.trim()) || requiredConnectorsMissing
            }
            onBack={handleBack}
          />
        }
      >
        {workflow ? (
          <section className="mt-[18px] flex flex-col gap-2 rounded-2xl border border-border bg-background p-4 shadow-sm">
            <div>
              <h2 className="text-sm font-semibold leading-5">
                {workflow.title}
              </h2>
              <p className="mt-1 text-sm leading-[22.75px] text-muted-foreground">
                {workflow.description}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <WorkflowConnectorPills connectorIds={workflow.connectors} />
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground hover:border-primary/35 hover:text-primary"
                aria-label="Preview workflow details"
                onClick={() => {
                  setUi({ workflowPreviewId: workflow.id });
                }}
              >
                <IconScanEye size={16} stroke={1.6} aria-hidden="true" />
              </button>
            </div>
          </section>
        ) : null}

        <OnboardingConnectorSetup connectorIds={workflow?.connectors ?? []}>
          <label className="sr-only" htmlFor="workflow-note">
            {custom
              ? "Describe your workflow"
              : "Anything else you would like to add?"}
          </label>
          <textarea
            id="workflow-note"
            value={draft.workflowNote}
            onChange={(event) => {
              setDraft({ workflowNote: event.target.value });
            }}
            placeholder={
              custom
                ? "Describe what you want Zero to build"
                : "Anything else you would like to add?"
            }
            rows={3}
            className="mt-[18px] min-h-[98px] w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
        </OnboardingConnectorSetup>
        {requiredConnectorsMissing && requiredState.missingLabels.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {`Connect ${formatConnectorList(requiredState.missingLabels)} to run this workflow.`}
          </p>
        ) : null}
      </OnboardingShell>
      {workflow && previewOpen ? (
        <WorkflowPreview
          workflow={workflow}
          onClose={() => {
            setUi({ workflowPreviewId: null });
          }}
          onSelect={() => {
            setUi({ workflowPreviewId: null });
          }}
        />
      ) : null}
    </>
  );
}
