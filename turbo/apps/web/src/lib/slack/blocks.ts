import type {
  Block,
  InputBlock,
  KnownBlock,
  View,
  SectionBlock,
} from "@slack/web-api";
import { getPlatformUrl } from "../url";

interface AgentOption {
  id: string;
  name: string;
  requiredSecrets: string[];
  existingSecrets: string[];
  requiredVars: string[];
  existingVars: string[];
}

interface BindingInfo {
  id: string;
  agentName: string;
  enabled: boolean;
}

/**
 * Build an input block for a variable or secret value
 * Used by both add and update modals
 */
function buildValueInputBlock(
  blockIdPrefix: string,
  name: string,
  isExisting: boolean,
  isRequired: boolean,
): InputBlock {
  const isOptional = !isRequired || isExisting;
  return {
    type: "input",
    block_id: `${blockIdPrefix}_${name}`,
    ...(isOptional && { optional: true }),
    element: {
      type: "plain_text_input",
      action_id: "value",
      placeholder: {
        type: "plain_text",
        text: isExisting
          ? "Leave empty to keep current value"
          : `Enter value for ${name}`,
      },
    },
    label: {
      type: "plain_text",
      text: isExisting ? `${name} ✓` : name,
    },
    ...(isExisting && {
      hint: {
        type: "plain_text",
        text: "Already configured in your account",
      },
    }),
  };
}

/**
 * Build blocks for the "existing agent" mode in the add modal
 */
function buildExistingAgentBlocks(
  agents: AgentOption[],
  selectedAgentId?: string,
  hasModelProvider?: boolean,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [];
  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId)
    : undefined;

  blocks.push({
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
  });

  // Model provider status (shown after agent selection, like vars/secrets)
  if (selectedAgent && hasModelProvider !== undefined) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Model Provider*" },
    });
    blocks.push(...buildModelProviderStatusBlocks(hasModelProvider));
  }

  if (selectedAgent && selectedAgent.requiredVars.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Variables*" },
    });

    const existingVarsSet = new Set(selectedAgent.existingVars);
    for (const varName of selectedAgent.requiredVars) {
      blocks.push(
        buildValueInputBlock(
          "var",
          varName,
          existingVarsSet.has(varName),
          true,
        ),
      );
    }
  }

  if (selectedAgent && selectedAgent.requiredSecrets.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Secrets*" },
    });

    const existingSecretsSet = new Set(selectedAgent.existingSecrets);
    for (const secretName of selectedAgent.requiredSecrets) {
      blocks.push(
        buildValueInputBlock(
          "secret",
          secretName,
          existingSecretsSet.has(secretName),
          true,
        ),
      );
    }
  }

  if (
    selectedAgent &&
    selectedAgent.requiredVars.length === 0 &&
    selectedAgent.requiredSecrets.length === 0
  ) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_This agent doesn't require any variables or secrets._",
      },
    });
  } else if (!selectedAgent) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Select an agent to see required configuration._",
      },
    });
  }

  return blocks;
}

/**
 * Build blocks for the GitHub URL compose modal
 */
function buildGithubUrlBlocks(): (Block | KnownBlock)[] {
  return [
    {
      type: "input",
      block_id: "github_url_input",
      element: {
        type: "plain_text_input",
        action_id: "github_url_value",
        placeholder: {
          type: "plain_text",
          text: "https://github.com/owner/repo",
        },
      },
      label: {
        type: "plain_text",
        text: "GitHub URL",
      },
      hint: {
        type: "plain_text",
        text: "The repository must contain a vm0.yaml file",
      },
    },
  ];
}

/**
 * Build the "Compose Agent" modal view
 *
 * Opens a modal with a GitHub URL input to compose a new agent.
 *
 * @param channelId - Channel ID to send confirmation message to
 * @returns Modal view definition
 */
export function buildAgentComposeModal(channelId?: string): View {
  return {
    type: "modal",
    callback_id: "agent_compose_modal",
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: "plain_text",
      text: "Compose Agent",
    },
    submit: {
      type: "plain_text",
      text: "Compose",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: buildGithubUrlBlocks(),
  };
}

/**
 * Build model provider status blocks for the agent add modal
 */
function buildModelProviderStatusBlocks(
  hasModelProvider: boolean,
): (Block | KnownBlock)[] {
  if (hasModelProvider) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":white_check_mark: Configured",
        },
      },
    ];
  }

  const platformUrl = getPlatformUrl();
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":warning: Not configured\nYou need to configure a model provider before your agent can run.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Go to Settings" },
          url: `${platformUrl}/settings`,
          action_id: "model_provider_settings",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Refresh" },
          action_id: "model_provider_refresh",
        },
      ],
    },
  ];
}

/**
 * Build the "Add Agent" modal view
 *
 * Shows a dropdown to select from existing agents and configure secrets/vars.
 *
 * @param agents - List of available agents
 * @param selectedAgentId - Currently selected agent ID
 * @param channelId - Channel ID to send confirmation message to
 * @param hasModelProvider - Whether the user has a model provider configured
 * @returns Modal view definition
 */
export function buildAgentAddModal(
  agents: AgentOption[],
  selectedAgentId?: string,
  channelId?: string,
  hasModelProvider = true,
): View {
  return {
    type: "modal",
    callback_id: "agent_add_modal",
    private_metadata: JSON.stringify({ channelId, hasModelProvider }),
    title: {
      type: "plain_text",
      text: "Link Agent",
    },
    submit: {
      type: "plain_text",
      text: "Link",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: buildExistingAgentBlocks(agents, selectedAgentId, hasModelProvider),
  };
}

/**
 * Build the App Home tab view
 *
 * @param options - Configuration for the home view
 * @returns View definition for the Home tab
 */
export function buildAppHomeView(options: {
  isLinked: boolean;
  vm0UserId?: string;
  userEmail?: string;
  bindings?: BindingInfo[];
  loginUrl?: string;
}): View {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Welcome to VM0! :wave:",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Connect your AI agents to Slack and interact with them through messages.",
      },
    },
    { type: "divider" },
  ];

  // Account status
  if (options.isLinked) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *Connected to VM0*\nAccount: ${options.userEmail || options.vm0UserId}`,
      },
    });
  } else {
    const connectBlocks: (Block | KnownBlock)[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":x: *Account not connected*",
        },
      },
    ];
    if (options.loginUrl) {
      connectBlocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Connect",
            },
            url: options.loginUrl,
            action_id: "home_login_prompt",
            style: "primary",
          },
        ],
      });
    }
    blocks.push(...connectBlocks);

    // Not connected — just show connect prompt, skip agents/commands
    return {
      type: "home",
      blocks,
    };
  }

  blocks.push({ type: "divider" });

  // Linked agents
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":robot_face: *Your Linked Agent*",
    },
  });

  if (options.bindings && options.bindings.length > 0) {
    for (const binding of options.bindings) {
      const agentText = `AgentName: *${binding.agentName}*`;
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: agentText,
        },
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Update" },
            action_id: "home_agent_update",
            value: binding.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Unlink" },
            action_id: "home_agent_unlink",
            value: binding.id,
            style: "danger",
          },
        ],
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No agent linked yet._",
      },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Link Agent" },
          action_id: "home_agent_link",
          style: "primary",
        },
      ],
    });
  }

  blocks.push({ type: "divider" });

  // Compose section
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":rocket: *Compose Agent*\nCreate a new agent from a GitHub repository.",
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Compose" },
      action_id: "home_agent_compose",
      style: "primary",
    },
  });

  blocks.push({ type: "divider" });

  // Help section
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":bulb: *Here are some things you can do:*",
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Chat with your agents*\nSend a DM or `@VM0` in any channel\n`@VM0 [your message]`",
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Link and manage agents*\nLink an agent\n`/vm0 agent link`\nUnlink an agent\n`/vm0 agent unlink`\nUpdate agent configuration\n`/vm0 agent update`\nCompose an agent from GitHub URL\n`/vm0 agent compose`",
    },
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: ":book: <https://docs.vm0.ai/docs/ecosystem/slack|View full documentation>",
      },
    ],
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Disconnect VM0 Account*\nThis will remove your VM0 account connection",
    },
    accessory: {
      type: "button",
      text: {
        type: "plain_text",
        text: "Disconnect",
      },
      action_id: "home_disconnect",
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Disconnect VM0 Account" },
        text: {
          type: "plain_text",
          text: "This will remove your VM0 account connection",
        },
        confirm: { type: "plain_text", text: "Disconnect" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    },
  });

  return {
    type: "home",
    blocks,
  };
}

interface AgentUpdateOption {
  id: string;
  name: string;
  requiredSecrets: string[];
  existingSecrets: string[];
  requiredVars: string[];
  existingVars: string[];
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

  // Add variables fields if agent is selected and has required vars
  if (selectedAgent && selectedAgent.requiredVars.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Update Variables*\n_Leave empty to keep current value_",
      },
    });

    const existingVarsSet = new Set(selectedAgent.existingVars);
    for (const varName of selectedAgent.requiredVars) {
      blocks.push(
        buildValueInputBlock(
          "var",
          varName,
          existingVarsSet.has(varName),
          false,
        ),
      );
    }
  }

  // Add secrets fields if agent is selected and has required secrets
  if (selectedAgent && selectedAgent.requiredSecrets.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Update Secrets*\n_Leave empty to keep current value_",
      },
    });

    const existingSecretsSet = new Set(selectedAgent.existingSecrets);
    for (const secretName of selectedAgent.requiredSecrets) {
      blocks.push(
        buildValueInputBlock(
          "secret",
          secretName,
          existingSecretsSet.has(secretName),
          false,
        ),
      );
    }
  }

  // Show message if no variables or secrets to update
  if (
    selectedAgent &&
    selectedAgent.requiredVars.length === 0 &&
    selectedAgent.requiredSecrets.length === 0
  ) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_This agent doesn't have any variables or secrets to update._",
      },
    });
  } else if (!selectedAgent) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Select an agent to update its configuration._",
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
          text: "You don't have any agent linked yet.\n\nUse `/vm0 agent link` to link one.",
        },
      },
    ];
  }

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":robot_face: *Your Linked Agent*",
      },
    },
    {
      type: "divider",
    },
  ];

  for (const binding of bindings) {
    const status = binding.enabled ? ":white_check_mark:" : ":x:";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${status} *${binding.agentName}*`,
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
 * Build a message prompting user to login
 *
 * @param loginUrl - URL to the login page
 * @returns Block Kit blocks
 */
export function buildLoginPromptMessage(
  loginUrl: string,
): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "To use VM0 in Slack, please connect your account first.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect",
          },
          url: loginUrl,
          action_id: "login_prompt",
          style: "primary",
        },
      ],
    },
  ];
}

/**
 * Build a welcome message for the Messages tab
 */
export function buildWelcomeMessage(
  agents: { agentName: string }[],
): (Block | KnownBlock)[] {
  const hasAgents = agents.length > 0;

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":wave: *Hi! I'm VM0.*\n\nI can connect you to AI agents to help with your tasks.",
      },
    },
    {
      type: "divider",
    },
  ];

  if (hasAgents) {
    const agentList = agents.map((a) => `• \`${a.agentName}\``).join("\n");

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Your Linked Agent*\n${agentList}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*How to Use*\n• Just describe what you need help with",
        },
      },
    );
  } else {
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Your Linked Agent*\n_No agent linked yet._ Use the button below to link one.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Link Agent",
            },
            action_id: "home_agent_link",
            style: "primary",
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*How to Use*\n• Link an agent first, then describe what you need help with",
        },
      },
    );
  }

  return blocks;
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
        text: "*Account*\n• `/vm0 connect` - Connect to VM0\n• `/vm0 disconnect` - Disconnect from VM0",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Agent*\n• `/vm0 agent link` - Link an agent\n• `/vm0 agent unlink` - Unlink your agent\n• `/vm0 agent update` - Update agent configuration\n• `/vm0 agent compose` - Compose an agent from GitHub URL",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Usage*\n• `@VM0 <message>` - Send a message to your agent",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":book: <https://docs.vm0.ai/docs/ecosystem/slack|View full documentation>",
        },
      ],
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
 * Build an agent response message with agent name context and optional logs link
 *
 * @param content - The agent's response content
 * @param agentName - The name of the agent that responded
 * @param logsUrl - Optional URL to the run logs
 * @returns Block Kit blocks with agent context header
 */
export function buildAgentResponseMessage(
  content: string,
  agentName: string,
  logsUrl?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:robot_face: *${agentName}*`,
        },
      ],
    },
    ...buildMarkdownMessage(content),
  ];

  // Add logs link at the end if provided
  if (logsUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${logsUrl}|:clipboard: View logs>`,
        },
      ],
    });
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
        text: "Please connect your account to use VM0 in this workspace.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect",
          },
          url: loginUrl,
          action_id: "login",
          style: "primary",
        },
      ],
    },
  ];
}
