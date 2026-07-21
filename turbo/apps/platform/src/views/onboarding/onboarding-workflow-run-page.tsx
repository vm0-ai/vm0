import { useGet, useSet } from "ccstate-react";
import { IconWand } from "@tabler/icons-react";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { OnboardingConnectorSetup } from "./onboarding-connectors.tsx";
import {
  buildCustomWorkflowPrompt,
  buildWorkflowPrompt,
  CUSTOM_WORKFLOW_ID,
  findOnboardingWorkflow,
} from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingRunAction } from "./onboarding-run-action.tsx";
import { OnboardingShell } from "./onboarding-shell.tsx";

export function OnboardingWorkflowRunPage() {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const { navigateTo } = useOnboardingNavigation();
  const custom = draft.workflowId === CUSTOM_WORKFLOW_ID;
  const workflow = findOnboardingWorkflow(draft.workflowId);
  const prompt = custom
    ? buildCustomWorkflowPrompt(draft.workflowNote)
    : workflow
      ? buildWorkflowPrompt(workflow, draft.workflowNote)
      : "";
  const title = custom
    ? "Build your own workflow"
    : (workflow?.title ?? "Choose a workflow");
  const description = custom
    ? "Tell Zero what should happen, when it should happen, and what a good result looks like."
    : (workflow?.description ?? "Return to the workflow picker to continue.");

  const handleBack = (): void => {
    navigateTo(ROUTES.onboardingWorkflowPicker, {
      updates: {
        choice: "workflow",
        category: draft.categoryId,
        workflow: draft.workflowId,
      },
    });
  };

  return (
    <OnboardingShell
      currentStep={3}
      totalSteps={3}
      title={title}
      description={description}
      footer={
        <OnboardingRunAction
          prompt={prompt}
          disabled={custom && !draft.workflowNote.trim()}
          onBack={handleBack}
        />
      }
    >
      {workflow ? (
        <div className="rounded-lg border border-border bg-[hsl(var(--gray-50))] p-4">
          <div className="flex items-start gap-3">
            <IconWand
              size={19}
              stroke={1.6}
              className="mt-0.5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-medium">First run</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {workflow.prompt}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <label className="mt-6 block text-sm font-medium" htmlFor="workflow-note">
        {custom ? "Describe your workflow" : "Add context (optional)"}
      </label>
      <textarea
        id="workflow-note"
        value={draft.workflowNote}
        onChange={(event) => {
          setDraft({ workflowNote: event.target.value });
        }}
        placeholder={
          custom
            ? "e.g. Every Friday, summarize open customer issues and post the priorities to Slack."
            : "Add a channel, project, audience, or other details for this run."
        }
        className="mt-2 min-h-28 w-full resize-y rounded-lg border border-border bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
      />

      <OnboardingConnectorSetup connectorIds={workflow?.connectors ?? []} />
    </OnboardingShell>
  );
}
