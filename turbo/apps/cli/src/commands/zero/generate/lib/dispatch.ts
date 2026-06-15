import { readPipedStdin } from "../../../../lib/utils/prompt-utils";
import { printConnectorGuidance } from "./connector-guidance";
import { runLister, type GenerationType } from "./lister";

interface DispatchOptions {
  readonly generationType: GenerationType;
  readonly provider?: string;
  readonly prompt?: string;
  readonly all?: boolean;
}

/**
 * Resolve the dispatch for `zero generate <type>`.
 *
 * Returns `"execute"` when the caller should run the built-in pipeline.
 * Otherwise prints the appropriate output (lister or connector guidance)
 * and returns `"handled"`.
 *
 * The dispatcher consumes any piped stdin used to satisfy the prompt and
 * places the resolved text on `options.prompt` for the caller to use.
 */
export async function dispatchGenerate(
  options: DispatchOptions,
): Promise<{ outcome: "handled" } | { outcome: "execute"; prompt: string }> {
  const provider = options.provider?.trim();

  if (provider && provider !== "built-in") {
    printConnectorGuidance(options.generationType, provider);
    return { outcome: "handled" };
  }

  const resolvedPrompt = resolvePrompt(options.prompt);

  if (resolvedPrompt === null) {
    await runLister(options.generationType, {
      all: options.all,
    });
    return { outcome: "handled" };
  }

  return { outcome: "execute", prompt: resolvedPrompt };
}

function resolvePrompt(prompt: string | undefined): string | null {
  if (prompt?.trim()) {
    return prompt.trim();
  }

  return readPipedStdin() ?? null;
}
