import type { Block, KnownBlock, View } from "@slack/web-api";

interface AgentOption {
  id: string;
  name: string;
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
 * @returns Modal view definition
 */
export function buildAgentAddModal(agents: AgentOption[]): View {
  return {
    type: "modal",
    callback_id: "agent_add_modal",
    title: {
      type: "plain_text",
      text: "Add Agent",
    },
    submit: {
      type: "plain_text",
      text: "Add",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "agent_select",
        element: {
          type: "static_select",
          action_id: "agent",
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
        },
        label: {
          type: "plain_text",
          text: "Agent",
        },
      },
      {
        type: "input",
        block_id: "agent_name",
        element: {
          type: "plain_text_input",
          action_id: "name",
          placeholder: {
            type: "plain_text",
            text: "e.g., my-coder",
          },
        },
        label: {
          type: "plain_text",
          text: "Name (for @VM0 use <name>)",
        },
      },
      {
        type: "input",
        block_id: "description",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "description",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Describe what this agent does (helps with auto-routing)",
          },
        },
        label: {
          type: "plain_text",
          text: "Description",
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Secrets* (optional)\nEnter any secrets this agent needs. Format: `KEY=value`, one per line.",
        },
      },
      {
        type: "input",
        block_id: "secrets",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "secrets",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "GITHUB_TOKEN=ghp_xxx\nOPENAI_API_KEY=sk-xxx",
          },
        },
        label: {
          type: "plain_text",
          text: "Secrets",
        },
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
        text: "*Commands*\n• `/vm0 agent add` - Add a new agent\n• `/vm0 agent list` - List your agents\n• `/vm0 agent remove <name>` - Remove an agent\n• `/vm0 help` - Show this help message",
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
