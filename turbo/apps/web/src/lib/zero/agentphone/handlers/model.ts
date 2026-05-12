import {
  getCanonicalModelDisplayName,
  normalizeRunModelId,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  getModelPreferencePickerState,
  type ModelPreferencePickerOption,
  type ModelPreferencePickerState,
} from "../../model-policy/model-preference-picker";
import { updateUserModelPreference } from "../../model-policy/user-model-preference-service";
import { sendAgentPhoneMessage } from "../client";

function commandArgument(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const firstWhitespaceIndex = trimmed.search(/\s/u);
  if (firstWhitespaceIndex === -1) return "";
  return trimmed.slice(firstWhitespaceIndex).trim();
}

function lookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
}

function compactLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function modelMatchesInput(
  option: ModelPreferencePickerOption,
  input: string,
): boolean {
  const normalizedInput = normalizeRunModelId(input.trim());
  const inputKeys = new Set([
    lookupKey(input),
    lookupKey(normalizedInput),
    compactLookupKey(input),
    compactLookupKey(normalizedInput),
  ]);
  const optionValues = [
    option.model,
    normalizeRunModelId(option.model),
    option.label,
    getCanonicalModelDisplayName(option.model),
  ];

  return optionValues.some((value) => {
    return (
      inputKeys.has(lookupKey(value)) || inputKeys.has(compactLookupKey(value))
    );
  });
}

function findModelOption(
  picker: ModelPreferencePickerState,
  input: string,
): ModelPreferencePickerOption | undefined {
  return picker.options.find((option) => {
    return modelMatchesInput(option, input);
  });
}

function formatWorkspaceDefaultName(
  picker: ModelPreferencePickerState,
): string {
  return picker.workspaceDefaultName
    ? `workspace default (${picker.workspaceDefaultName})`
    : "workspace default";
}

function formatCurrentModelLine(picker: ModelPreferencePickerState): string {
  if (!picker.currentSelectedModel) {
    return `Current: ${formatWorkspaceDefaultName(picker)}`;
  }

  return `Current: ${getCanonicalModelDisplayName(picker.currentSelectedModel)}`;
}

function formatAgentPhoneModelOptionsMessage(
  picker: ModelPreferencePickerState,
): string {
  const optionLines = picker.options.map((option) => {
    const markers = [
      option.model === picker.currentSelectedModel ? "current" : null,
      option.isDefault ? "workspace default" : null,
    ].filter((marker): marker is string => {
      return marker !== null;
    });
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    return `/model ${option.model} - ${option.label}${suffix}`;
  });

  return [
    "Available models",
    "",
    formatCurrentModelLine(picker),
    "",
    "Send one of these commands to switch:",
    ...optionLines,
  ].join("\n");
}

function formatUnknownModelMessage(
  input: string,
  picker: ModelPreferencePickerState,
): string {
  return [
    `Error: Unknown model "${input}".`,
    "",
    formatAgentPhoneModelOptionsMessage(picker),
  ].join("\n");
}

export async function handleAgentPhoneModelCommand(params: {
  text: string;
  agentphoneAgentId: string;
  phoneHandle: string;
  orgId: string;
  userId: string;
}): Promise<void> {
  const picker = await getModelPreferencePickerState({
    orgId: params.orgId,
    userId: params.userId,
  });

  if (!picker.enabled) {
    await sendAgentPhoneMessage({
      agentphoneAgentId: params.agentphoneAgentId,
      toNumber: params.phoneHandle,
      body: "Error: Model switching is not available for this workspace.",
    });
    return;
  }

  if (picker.options.length === 0) {
    await sendAgentPhoneMessage({
      agentphoneAgentId: params.agentphoneAgentId,
      toNumber: params.phoneHandle,
      body: "Error: No models are configured for this workspace.",
    });
    return;
  }

  const input = commandArgument(params.text);
  if (!input) {
    await sendAgentPhoneMessage({
      agentphoneAgentId: params.agentphoneAgentId,
      toNumber: params.phoneHandle,
      body: formatAgentPhoneModelOptionsMessage(picker),
    });
    return;
  }

  const option = findModelOption(picker, input);
  if (!option) {
    await sendAgentPhoneMessage({
      agentphoneAgentId: params.agentphoneAgentId,
      toNumber: params.phoneHandle,
      body: formatUnknownModelMessage(input, picker),
    });
    return;
  }

  await updateUserModelPreference(params.orgId, params.userId, option.model);
  await sendAgentPhoneMessage({
    agentphoneAgentId: params.agentphoneAgentId,
    toNumber: params.phoneHandle,
    body: `Switched to ${option.label}.`,
  });
}
