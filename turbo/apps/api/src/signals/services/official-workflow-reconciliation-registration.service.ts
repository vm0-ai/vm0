import { configureOfficialWorkflowReconciliationCommand } from "./official-workflow-reconciliation-dispatch.service";
import { reconcileOfficialWorkflowInstallation$ } from "./official-workflow-reconciliation.service";

/** Wire Official Workflow reconciliation at the API composition root. */
export function configureOfficialWorkflowReconciliationDispatcher(): void {
  configureOfficialWorkflowReconciliationCommand(
    reconcileOfficialWorkflowInstallation$,
  );
}
