import { badRequest } from "@vm0/api-services/errors";
import {
  getFrameworkForType,
  getSecretNameForType,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { resolveFrameworkApiKeyEnvVar } from "../../framework/framework-config";
import type { AgentComposeYaml } from "../../agent-compose/types";
import { resolveRuntimeFramework } from "./resolve-runtime-framework";

/**
 * Validate that a compose's environment block declares the framework's
 * required API-key env var, OR that a configured model provider supplies
 * the equivalent secret at runtime.
 *
 * claude-code is exempt: the org-level model-provider system
 * (`checkModelProviderConfigured`) already gates runs that lack
 * `ANTHROPIC_API_KEY`. Other frameworks (codex today) are satisfied when
 * any of:
 *   (a) compose `environment` declares the framework's key (literal or
 *       `${{ secrets.X }}` placeholder), OR
 *   (b) a configured single-secret `providerType`'s `secretName` matches
 *       the framework's required env var — runtime injection from the
 *       provider supplies the key without compose-level declaration
 *       (e.g., openai-api-key → OPENAI_API_KEY), OR
 *   (c) a configured multi-auth `providerType` is registered with the
 *       resolved framework. Multi-auth providers self-provision auth via
 *       firewall-replaced injection rather than the framework's canonical
 *       env var, so the env-var requirement does not apply
 *       (e.g., codex-oauth-token → ChatGPT mode placeholder auth.json,
 *       per Epic #11974).
 *
 * @throws BadRequestError when none of the paths are satisfied.
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
  const framework = resolveRuntimeFramework({
    providerType,
    agentCompose: compose,
  });
  if (framework === "claude-code") return;

  const requiredVar = resolveFrameworkApiKeyEnvVar(framework);
  const env = agent.environment ?? {};
  if (requiredVar in env) return;

  if (providerType && getSecretNameForType(providerType) === requiredVar) {
    return;
  }

  // Multi-auth providers (e.g., codex-oauth-token) don't expose a single
  // top-level `secretName`, so the previous check returns false. Their
  // authoritative path is the firewall-replacement layer + sandbox-side
  // placeholder bootstrap — the framework's env var is intentionally NOT
  // populated. Accept them when their framework matches the run's
  // resolved framework.
  if (providerType && getFrameworkForType(providerType) === framework) {
    return;
  }

  throw badRequest(
    `Compose with framework "${framework}" requires ${requiredVar} ` +
      `in agent environment. Set it as a literal value or as a secret ` +
      `reference: \${{ secrets.${requiredVar} }}`,
  );
}
