import type { ModelProviderType } from "@vm0/core";

import anthropicIcon from "./icons/anthropic.svg";
import azureIcon from "./icons/azure.svg";
import bedrockIcon from "./icons/bedrock.svg";
import chatglmIcon from "./icons/chatglm.svg";
import claudeCodeIcon from "./icons/claude-code.svg";
import deepseekIcon from "./icons/deepseek.svg";
import kimiIcon from "./icons/kimi.svg";
import minimaxIcon from "./icons/minimax.svg";
import openrouterIcon from "./icons/openrouter.svg";

const PROVIDER_ICONS: Readonly<Record<ModelProviderType, string>> =
  Object.freeze({
    "claude-code-oauth-token": claudeCodeIcon,
    "anthropic-api-key": anthropicIcon,
    "openrouter-api-key": openrouterIcon,
    "minimax-api-key": minimaxIcon,
    "deepseek-api-key": deepseekIcon,
    "zai-api-key": chatglmIcon,
    "moonshot-api-key": kimiIcon,
    "azure-foundry": azureIcon,
    "aws-bedrock": bedrockIcon,
  });

export function ProviderIcon({
  type,
  size = 28,
}: {
  type: ModelProviderType;
  size?: number;
}) {
  const icon = PROVIDER_ICONS[type];
  if (!icon) {
    return <DefaultIcon size={size} />;
  }
  return (
    <img src={icon} width={size} height={size} alt="" className="shrink-0" />
  );
}

function DefaultIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
    >
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8Zm-1-13h2v6h-2Zm0 8h2v2h-2Z"
        fill="currentColor"
        className="text-muted-foreground"
      />
    </svg>
  );
}
