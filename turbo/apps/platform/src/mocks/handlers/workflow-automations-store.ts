import type { ChatThreadWorkflowAutomation } from "@okouai/api-contracts/contracts/workflows";

// Shared in-memory store backing workflow automation mock handlers.
let mockWorkflowAutomations: ChatThreadWorkflowAutomation[] = [];

export function getMockWorkflowAutomations(): ChatThreadWorkflowAutomation[] {
  return mockWorkflowAutomations;
}

export function setMockWorkflowAutomations(
  automations: ChatThreadWorkflowAutomation[],
): void {
  mockWorkflowAutomations = automations;
}

export function resetMockWorkflowAutomations(): void {
  mockWorkflowAutomations = [];
}
