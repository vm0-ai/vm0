import type { Block, KnownBlock, View, SectionBlock } from "@slack/web-api";

interface AgentOption {
  id: string;
  name: string;
  requiredSecrets: string[];
}

interface BindingInfo {
  agentName: string;
  description: string | null;
  enabled: boolean;
}

/**
 * Build the "Add Agent" modal view
 *
 * @param agents - List of available agents
 * @param selectedAgentId - Currently selected agent ID
 * @param channelId - Channel ID to send confirmation message to
 * @returns Modal view definition
 */
export function buildAgentAddModal(
  agents: AgentOption[],
  selectedAgentId?: string,
  channelId?: string,
): View {
  // Find selected agent or default to first
  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId)
    : undefined;

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "input",
      block_id: "agent_select",
      dispatch_action: true,
      element: {
        type: "static_select",
        action_id: "agent_select_action",
        placeholder: {
          type: "plain_text",
          text: "Select an agent",
        },
        options: agents.map((agent) => ({
          text: {
            type: "plain_text" as const,
            text: agent.name,
          },
          value: agent.id,
        })),
        ...(selectedAgentId && {
          initial_option: {
            text: {
              type: "plain_text" as const,
              text: selectedAgent?.name ?? "",
            },
            value: selectedAgentId,
          },
        }),
      },
      label: {
        type: "plain_text",
        text: "Agent",
      },
    },
  ];

  // Add secrets fields if agent is selected and has required secrets
  if (selectedAgent && selectedAgent.requiredSecrets.length > 0) {
    blocks.push({
      type: "divider",
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Required Secrets*",
      },
    });

    for (const secretName of selectedAgent.requiredSecrets) {
      blocks.push({
        type: "input",
        block_id: `secret_${secretName}`,
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: `Enter value for ${secretName}`,
          },
        },
        label: {
          type: "plain_text",
          text: secretName,
        },
      });
    }
  } else if (selectedAgent && selectedAgent.requiredSecrets.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_This agent doesn't require any secrets._",
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Select an agent to see required secrets._",
      },
    });
  }

  return {
    type: "modal",
    callback_id: "agent_add_modal",
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: "plain_text",
      text: "Add Agent",
    },
    submit: selectedAgent
      ? {
          type: "plain_text",
          text: "Add",
        }
      : undefined,
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks,
  };
}

interface AgentBinding {
  id: string;
  agentName: string;
}

interface AgentUpdateOption {
  id: string;
  name: string;
  requiredSecrets: string[];
}

/**
 * Build the "Update Agent" modal view
 *
 * @param agents - List of bound agents with their required secrets
 * @param selectedAgentId - Currently selected agent ID
 * @param channelId - Channel ID to send confirmation message to
 * @returns Modal view definition
 */
export function buildAgentUpdateModal(
  agents: AgentUpdateOption[],
  selectedAgentId?: string,
  channelId?: string,
): View {
  // Find selected agent or default to first
  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId)
    : undefined;

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "input",
      block_id: "agent_select",
      dispatch_action: true,
      element: {
        type: "static_select",
        action_id: "agent_update_select_action",
        placeholder: {
          type: "plain_text",
          text: "Select an agent to update",
        },
        options: agents.map((agent) => ({
          text: {
            type: "plain_text" as const,
            text: agent.name,
          },
          value: agent.id,
        })),
        ...(selectedAgentId && {
          initial_option: {
            text: {
              type: "plain_text" as const,
              text: selectedAgent?.name ?? "",
            },
            value: selectedAgentId,
          },
        }),
      },
      label: {
        type: "plain_text",
        text: "Agent",
      },
    },
  ];

  // Add secrets fields if agent is selected and has required secrets
  if (selectedAgent && selectedAgent.requiredSecrets.length > 0) {
    blocks.push({
      type: "divider",
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Update Secrets*\n_Leave empty to keep current value_",
      },
    });

    for (const secretName of selectedAgent.requiredSecrets) {
      blocks.push({
        type: "input",
        block_id: `secret_${secretName}`,
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: `Enter new value for ${secretName}`,
          },
        },
        label: {
          type: "plain_text",
          text: secretName,
        },
      });
    }
  } else if (selectedAgent && selectedAgent.requiredSecrets.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_This agent doesn't have any secrets to update._",
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Select an agent to update its secrets._",
      },
    });
  }

  return {
    type: "modal",
    callback_id: "agent_update_modal",
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: "plain_text",
      text: "Update Agent",
    },
    submit: selectedAgent
      ? {
          type: "plain_text",
          text: "Update",
        }
      : undefined,
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks,
  };
}

/**
 * Build the "Remove Agent" modal view with multi-select
 *
 * @param agents - List of bound agents
 * @param channelId - Channel ID to send confirmation message to
 * @returns Modal view definition
 */
export function buildAgentRemoveModal(
  agents: AgentBinding[],
  channelId?: string,
): View {
  return {
    type: "modal",
    callback_id: "agent_remove_modal",
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: "plain_text",
      text: "Remove Agents",
    },
    submit: {
      type: "plain_text",
      text: "Remove",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "agents_select",
        element: {
          type: "multi_static_select",
          action_id: "agents_select_action",
          placeholder: {
            type: "plain_text",
            text: "Select agents to remove",
          },
          options: agents.map((agent) => ({
            text: {
              type: "plain_text" as const,
              text: agent.agentName,
            },
            value: agent.id,
          })),
        },
        label: {
          type: "plain_text",
          text: "Select agents to remove",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ":warning: This action cannot be undone.",
          },
        ],
      },
    ],
  };
}

/**
 * Build a message listing bound agents
 *
 * @param bindings - List of agent bindings
 * @returns Block Kit blocks
 */
export function buildAgentListMessage(
  bindings: BindingInfo[],
): (Block | KnownBlock)[] {
  if (bindings.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "You don't have any agents bound yet.\n\nUse `/vm0 agent add` to add one.",
        },
      },
    ];
  }

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Your Bound Agents*",
      },
    },
    {
      type: "divider",
    },
  ];

  for (const binding of bindings) {
    const status = binding.enabled ? ":white_check_mark:" : ":x:";
    const description = binding.description ?? "_No description_";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${status} *${binding.agentName}*\n${description}`,
      },
    });
  }

  return blocks;
}

/**
 * Build an error message
 *
 * @param error - Error message
 * @returns Block Kit blocks
 */
export function buildErrorMessage(error: string): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:x: *Error*\n${error}`,
      },
    },
  ];
}

/**
 * Build a message prompting user to link their account
 *
 * @param linkUrl - URL to the linking page
 * @returns Block Kit blocks
 */
export function buildLinkAccountMessage(
  linkUrl: string,
): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "To use VM0 in Slack, please link your account first.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Link Account",
          },
          url: linkUrl,
          action_id: "link_account",
          style: "primary",
        },
      ],
    },
  ];
}

/**
 * Build a help message
 *
 * @returns Block Kit blocks
 */
export function buildHelpMessage(): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*VM0 Slack Bot Help*",
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Account*\n• `/vm0 login` - Link your VM0 account\n• `/vm0 logout` - Unlink your account",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Agents*\n• `/vm0 agent add` - Add a new agent\n• `/vm0 agent list` - List your agents\n• `/vm0 agent update` - Update agent secrets\n• `/vm0 agent remove` - Remove agents",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Usage*\n• `@VM0 <message>` - Auto-route to best agent\n• `@VM0 use <agent> <message>` - Use specific agent",
      },
    },
  ];
}

/**
 * Build a success message
 *
 * @param message - Success message
 * @returns Block Kit blocks
 */
export function buildSuccessMessage(message: string): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: ${message}`,
      },
    },
  ];
}

/**
 * Build markdown message blocks
 * Splits long content into multiple section blocks (Slack limit: 3000 chars per block)
 *
 * @param content - Markdown content
 * @returns Block Kit blocks
 */
/**
 * Convert standard Markdown to Slack mrkdwn format
 */
function convertToSlackMarkdown(content: string): string {
  let result = content;

  // Convert headers (## Header -> *Header*)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert bold (**text** -> *text*)
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert links [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert inline code (already works in Slack)
  // `code` stays as `code`

  // Convert horizontal rules (--- or ***) to divider-like text
  result = result.replace(/^[-*]{3,}$/gm, "───────────────");

  return result;
}

export function buildMarkdownMessage(content: string): (Block | KnownBlock)[] {
  const MAX_BLOCK_LENGTH = 2900; // Leave some margin below 3000
  const blocks: SectionBlock[] = [];

  // Convert standard Markdown to Slack mrkdwn
  const slackContent = convertToSlackMarkdown(content);

  // Split content into chunks if too long
  let remaining = slackContent;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_BLOCK_LENGTH) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: remaining,
        },
      });
      break;
    }

    // Find a good split point (newline or space)
    let splitIndex = remaining.lastIndexOf("\n", MAX_BLOCK_LENGTH);
    if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(" ", MAX_BLOCK_LENGTH);
    }
    if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
      splitIndex = MAX_BLOCK_LENGTH;
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: remaining.substring(0, splitIndex),
      },
    });
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return blocks;
}

/**
 * Build a message prompting user to login
 *
 * @param loginUrl - URL to the OAuth login page
 * @returns Block Kit blocks
 */
export function buildLoginMessage(loginUrl: string): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Please login to use VM0 in this workspace.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Login",
          },
          url: loginUrl,
          action_id: "login",
          style: "primary",
        },
      ],
    },
  ];
}
