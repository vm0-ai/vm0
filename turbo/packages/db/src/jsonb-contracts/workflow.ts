import type { JsonObject } from "./shared";
import type { OfficialWorkflowParameterBinding as ApiOfficialWorkflowParameterBinding } from "@okouai/api-contracts/contracts/official-workflow-bindings";

export type WorkflowAutomationEventConfig = JsonObject;
export type OfficialWorkflowParameterBinding =
  ApiOfficialWorkflowParameterBinding;
export type OfficialWorkflowParameterBindings =
  OfficialWorkflowParameterBinding[];
