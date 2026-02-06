import type { ModelProviderType } from "@vm0/core";
import { IconCloud } from "@tabler/icons-react";

function getProviderIconSrc(type: ModelProviderType): string | null {
  switch (type) {
    case "claude-code-oauth-token": {
      return "/images/onboarding/claude-icon.svg";
    }
    case "anthropic-api-key": {
      return "https://cdn.simpleicons.org/anthropic";
    }
    case "openrouter-api-key": {
      return "https://cdn.simpleicons.org/openrouter";
    }
    case "deepseek-api-key": {
      return "https://cdn.simpleicons.org/deepseek";
    }
    case "azure-foundry": {
      return "https://cdn.simpleicons.org/microsoftazure";
    }
    case "aws-bedrock": {
      return "https://cdn.simpleicons.org/amazonaws";
    }
    default: {
      return null;
    }
  }
}

export function ProviderIcon({
  type,
  size = 20,
}: {
  type: ModelProviderType;
  size?: number;
}) {
  const src = getProviderIconSrc(type);

  if (!src) {
    return (
      <IconCloud size={size} stroke={1.5} className="text-muted-foreground" />
    );
  }

  return (
    <img src={src} alt={type} width={size} height={size} className="shrink-0" />
  );
}
