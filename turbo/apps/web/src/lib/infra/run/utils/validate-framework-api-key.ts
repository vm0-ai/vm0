import { getValidatedFramework } from "@vm0/core/frameworks";
import { badRequest } from "@vm0/api-services/errors";
import {
  getFrameworkForType,
  getSecretNameForType,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { resolveFrameworkApiKeyEnvVar } from "../../framework/framework-config";
import type { AgentComposeYaml } from "../../agent-compose/types";

/**
 * Validate that a compose's environment block declares the framework's
 * required API-key env var, OR that a configured model provider supplies
 * the equivalent secret at runtime.
 *
 * claude-code is exempt: the org-level model-provider system
 * (`checkModelProviderConfigured`) already gates runs that lack
 * `ANTHROPIC_API_KEY`. Other frameworks (codex today) are satisfied when
 * either:
 *   (a) compose `environment` declares the framework's key (literal or
 *       `${{ secrets.X }}` placeholder), OR
 *   (b) a configured `providerType`'s `secretName` matches the framework's
 *       required env var — runtime injection from the provider supplies the
 *       key without compose-level declaration.
 *
 * @throws BadRequestError when neither path is satisfied.
 */
export function validateFrameworkApiKey(
  compose: AgentComposeYaml,
  providerType?: ModelProviderType | null,
): void {
  const agents = compose.agents ? Object.values(compose.agents) : [];
  const agent = agents[0];
  if (!agent) return;

  // Provider's framework wins (Epic #11520 design intent); compose
  // framework is fallback for CLI/no-provider paths. Without this, a
  // compose=claude-code + provider=openai-api-key (codex) thread would
  // exit early on the claude-code branch and skip OPENAI_API_KEY checks.
  const resolvedFrameworkName = providerType
    ? getFrameworkForType(providerType)
    : agent.framework;
  const framework = getValidatedFramework(resolvedFrameworkName);
  if (framework === "claude-code") return;

  const requiredVar = resolveFrameworkApiKeyEnvVar(framework);
  const env = agent.environment ?? {};
  if (requiredVar in env) return;

  if (providerType && getSecretNameForType(providerType) === requiredVar) {
    return;
  }

  throw badRequest(
    `Compose with framework "${framework}" requires ${requiredVar} ` +
      `in agent environment. Set it as a literal value or as a secret ` +
      `reference: \${{ secrets.${requiredVar} }}`,
  );
}
