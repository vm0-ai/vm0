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
import { escapeHtml } from "../format";
import { sendMessage, type TelegramClient } from "../client";
import {
  formatTelegramCommandError,
  formatTelegramCommandSuccess,
} from "./shared";
import type { TelegramHandlerUpdate } from "./types";

function commandArgument(text: string | undefined): string {
  const trimmed = text?.trim();
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
    return `Current: <b>${escapeHtml(formatWorkspaceDefaultName(picker))}</b>`;
  }

  return `Current: <b>${escapeHtml(
    getCanonicalModelDisplayName(picker.currentSelectedModel),
  )}</b>`;
}

function formatTelegramModelOptionsMessage(
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
    return `• <code>/model ${escapeHtml(option.model)}</code> - ${escapeHtml(
      option.label,
    )}${escapeHtml(suffix)}`;
  });

  return [
    "<b>Available models</b>",
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
    formatTelegramCommandError(`Unknown model "${input}".`),
    "",
    formatTelegramModelOptionsMessage(picker),
  ].join("\n");
}

export async function handleTelegramModelCommand(params: {
  message: TelegramHandlerUpdate["message"];
  client: TelegramClient;
  orgId: string;
  userId: string;
  replyToMessageId?: number;
}): Promise<void> {
  const chatId = String(params.message.chat.id);
  const replyOptions = params.replyToMessageId
    ? { replyToMessageId: params.replyToMessageId }
    : undefined;
  const picker = await getModelPreferencePickerState({
    orgId: params.orgId,
    userId: params.userId,
  });

  if (!picker.enabled) {
    await sendMessage(
      params.client,
      chatId,
      formatTelegramCommandError(
        "Model switching is not available for this workspace.",
      ),
      replyOptions,
    );
    return;
  }

  if (picker.options.length === 0) {
    await sendMessage(
      params.client,
      chatId,
      formatTelegramCommandError(
        "No models are configured for this workspace.",
      ),
      replyOptions,
    );
    return;
  }

  const input = commandArgument(params.message.text ?? params.message.caption);
  if (!input) {
    await sendMessage(
      params.client,
      chatId,
      formatTelegramModelOptionsMessage(picker),
      replyOptions,
    );
    return;
  }

  const option = findModelOption(picker, input);
  if (!option) {
    await sendMessage(
      params.client,
      chatId,
      formatUnknownModelMessage(input, picker),
      replyOptions,
    );
    return;
  }

  await updateUserModelPreference(params.orgId, params.userId, option.model);
  await sendMessage(
    params.client,
    chatId,
    formatTelegramCommandSuccess(`Switched to ${option.label}.`),
    replyOptions,
  );
}
