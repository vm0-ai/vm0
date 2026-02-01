# Slack Bot for VM0 Agent Run & Continue

## Summary

Enable users to trigger VM0 agent runs and continues through @bot mentions in Slack. Each Slack user links their VM0 account and binds their own agents to the workspace. When a user @VM0, they trigger their own agents (not someone else's). An LLM Router automatically selects the appropriate agent based on the user's message.

## Motivation

Users want to interact with their VM0 agents directly from Slack without leaving their communication workflow. The setup should be as simple as possible - no manual Slack App creation required.

## User Stories

1. As a user, I want to link my Slack account to my VM0 account
2. As a user, I want to bind my agents to my Slack workspace
3. As a user, I want to @VM0 in Slack and have the system auto-select the right agent from MY enabled agents
4. As a user, I want to explicitly specify an agent with `@VM0 <agent-name> <prompt>`
5. As a user, I want to continue a conversation by replying in a Slack thread
6. As a user, I want to see the agent's result as a reply in the thread
7. As a user, I want to use `/vm0 list` to see my bound agents

## Detailed Design

### Architecture: VM0-Hosted Slack App

VM0 hosts a single Slack App that serves all workspaces. Each Slack user links their VM0 account and binds their own agents.

**Key characteristics**:
- Single @VM0 bot identity across all workspaces
- Each Slack user links to their VM0 account
- Each user binds their own agents with their own secrets
- When User A @VM0, only User A's agents are available
- No cross-user secret exposure

### User Flow

#### Step 1: Link Slack Account to VM0

```bash
$ vm0 slack link

Linking Slack account to VM0...
Opening browser for Slack authorization...

Please sign in to Slack and authorize VM0.

Waiting for authorization.....

✓ Slack account linked!
  Workspace: Acme Corp (T12345ABC)
  Slack User: @alice (U12345)
```

Or in Slack (first-time @VM0):
```
Alice: @VM0 hello

VM0: Hi Alice! Please link your VM0 account first: https://vm0.ai/slack/link?token=xxx

[Alice clicks link, completes OAuth]

VM0: ✓ Account linked! You can now bind agents with `vm0 slack agent add <agent-name>`
```

#### Step 2: Bind Your Agents to Workspace

```bash
$ vm0 slack agent add my-coder

Adding agent "my-coder" to Slack workspace...

? Select workspace: Acme Corp (T12345ABC)
? Description (for auto-routing): Writes and reviews code, fixes bugs

Agent requires the following secrets:
? OPENAI_API_KEY: sk-...

✓ Agent "my-coder" bound to Acme Corp
```

#### Step 3: Use in Slack

**Auto-routing (LLM selects agent):**
```
User: @VM0 analyze this quarter's sales data

VM0: [Using my-analyst...]

VM0: Based on my analysis of Q4 sales data:
     - Revenue increased 15% QoQ
     - Top performing region: APAC
     ...
```

**Explicit agent selection:**
```
User: @VM0 my-coder fix the bug in auth.ts

VM0: [Using my-coder...]

VM0: I've identified and fixed the authentication bug...
```

**Continue in thread (same agent):**
```
User (in thread): @VM0 also check the login page

VM0: [Continuing with my-coder...]

VM0: I've reviewed the login page as well...
```

**List bound agents:**
```
User: /vm0 list

VM0: Your agents in this workspace:
     • my-coder - Writes and reviews code, fixes bugs
     • my-analyst - Analyzes data, creates reports and charts
```

### Core Concepts

#### Multi-Agent Routing

Each user can bind multiple agents to a workspace. When @VM0 is triggered, the system routes to the appropriate agent:

```
@VM0 <message>
    │
    ├─► 1. Existing thread session? → Use same agent (continue)
    │
    ├─► 2. Message starts with agent name? (@VM0 my-coder ...) → Use specified agent
    │
    ├─► 3. LLM Router selection
    │       ├─► Match found → Use selected agent
    │       └─► No match → Prompt user
    │
    └─► 4. Prompt: "I have multiple agents available: [list]. Please specify: @VM0 <agent-name> <prompt>"
```

**LLM Router**: Uses agent descriptions to match user intent. Returns the best-matching agent name or "none".

#### Thread-to-Session Mapping

- Main message @VM0 → Creates new VM0 session with routed agent
- Thread reply @VM0 → Continues existing session (uses same agent)
- Use Slack's `thread_ts` to track which agent owns the thread

#### Permission Model: User Triggers Own Agents

**Security Principle**: When a user @VM0, they trigger their OWN agents enabled on VM0.

```
Slack Workspace "Acme Corp"
├── Alice (linked to VM0 account alice@acme.com)
│   └── Enabled agents: my-coder, my-analyst (with Alice's secrets)
│
├── Bob (linked to VM0 account bob@acme.com)
│   └── Enabled agents: research-bot (with Bob's secrets)
│
└── Carol (NOT linked to VM0)
    └── @VM0 → "Please link your VM0 account first"
```

**Security Properties**:
- No one can use another user's secrets
- No one can trigger another user's agents
- Clear ownership and billing attribution
- Per-user audit trail

**Requirement**: Slack users must link their VM0 accounts before using @VM0.

#### Secrets Management

Follow the Schedule pattern:
- Store encrypted secrets at agent binding time
- Decrypt at runtime for each run

## Security Considerations

1. **User isolation**: Each user triggers their own agents with their own secrets
2. **No cross-user access**: Users cannot see or trigger other users' agents
3. **Account linking required**: Unlinked Slack users cannot use @VM0

## Out of Scope (Future)

1. Team/shared agents (all users see same agents)
2. Streaming responses to Slack
3. Multiple slash command subcommands (only `/vm0 list` for MVP)
4. Cross-workspace agent sharing

## References

- [Slack OAuth 2.0](https://api.slack.com/authentication/oauth-v2)
- [Slack Events API](https://api.slack.com/apis/events-api)
- Research document: `/tmp/deep-dive/slack-vm0-agent-bot/research.md`
