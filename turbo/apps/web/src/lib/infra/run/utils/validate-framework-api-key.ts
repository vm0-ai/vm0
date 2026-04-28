import { getValidatedFramework } from "@vm0/core/frameworks";
import { badRequest } from "@vm0/api-services/errors";
import { resolveFrameworkApiKeyEnvVar } from "../../framework/framework-config";
import type { AgentComposeYaml } from "../../agent-compose/types";

/**
 * Validate that a compose's environment block declares the framework's
 * required API-key env var.
 *
 * claude-code is exempt: the org-level model-provider system
 * (`checkModelProviderConfigured`) already gates runs that lack
 * `ANTHROPIC_API_KEY` and supports runtime injection from the org's default
 * provider. Frameworks without an org-level injection path (codex today)
 * must declare the key in the compose `environment` — either as a literal
 * value or as a `${{ secrets.X }}` placeholder; the runner resolves the
 * placeholder at execution time and surfaces its own error if the secret
 * is missing.
 *
 * @throws BadRequestError if the env var is absent for a framework that
 *   requires compose-level declaration.
 */
export function validateFrameworkApiKey(compose: AgentComposeYaml): void {
  const agents = compose.agents ? Object.values(compose.agents) : [];
  const agent = agents[0];
  if (!agent) return;

  const framework = getValidatedFramework(agent.framework);
  if (framework === "claude-code") return;

  const requiredVar = resolveFrameworkApiKeyEnvVar(framework);
  const env = agent.environment ?? {};
  if (!(requiredVar in env)) {
    throw badRequest(
      `Compose with framework "${framework}" requires ${requiredVar} ` +
        `in agent environment. Set it as a literal value or as a secret ` +
        `reference: \${{ secrets.${requiredVar} }}`,
    );
  }
}
