import { normalizeRunModelId } from "@vm0/api-contracts/contracts/model-providers";

/**
 * Return the vendor/model stem used for chat session continuity.
 *
 * Model IDs may be provider-qualified (for example, anthropic/claude-opus),
 * while the session family is the first part of the canonical model ID
 * (claude, gpt, glm, ...). Auto is explicitly treated as part of the GPT
 * family. This intentionally treats model variants in one family as compatible
 * while keeping different families isolated.
 */
function chatSessionModelFamily(model: string): string {
  const normalized = normalizeRunModelId(model.trim()).toLowerCase();
  const modelName = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  if (modelName === "vm0-model") {
    return "gpt";
  }
  return modelName.split(/[-_.]/, 1)[0] ?? modelName;
}

export function shouldStartNewChatSession(args: {
  readonly latestModel: string | null | undefined;
  readonly nextModel: string | null;
}): boolean {
  if (
    args.latestModel === undefined ||
    args.latestModel === null ||
    args.nextModel === null
  ) {
    return false;
  }

  return (
    chatSessionModelFamily(args.latestModel) !==
    chatSessionModelFamily(args.nextModel)
  );
}
