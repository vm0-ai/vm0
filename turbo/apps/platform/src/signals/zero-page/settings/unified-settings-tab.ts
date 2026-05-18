import { command, computed, state } from "ccstate";

export type UnifiedSettingsTabId =
  // Personal
  | "appearance"
  | "timezone"
  | "personal-models"
  | "usage"
  | "lab"
  | "debug"
  // Workspace
  | "general"
  | "members"
  | "ws-models"
  | "domains"
  | "billing"
  | "credit-balance"
  | "invoices";

const internalActiveTab$ = state<UnifiedSettingsTabId>("personal-models");

export const activeUnifiedSettingsTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const setActiveUnifiedSettingsTab$ = command(
  ({ set }, tab: UnifiedSettingsTabId) => {
    set(internalActiveTab$, tab);
  },
);
