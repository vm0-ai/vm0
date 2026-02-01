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

```bash
$ vm0 slack agent add my-analyst

Adding agent "my-analyst" to Slack workspace...

? Select workspace: Acme Corp (T12345ABC)
? Description (for auto-routing): Analyzes data, creates reports and charts

Agent requires the following secrets:
? OPENAI_API_KEY: sk-...

✓ Agent "my-analyst" bound to Acme Corp
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

Each workspace can have multiple agents bound. When a user @mentions VM0, the system routes to the appropriate agent:

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

**LLM Router**: Uses agent descriptions to match user intent. Lightweight LLM call that returns the best-matching agent name or "none".

**Routing Input**:
```json
{
  "user_message": "fix the bug in auth.ts",
  "agents": [
    { "name": "my-coder", "description": "Writes and reviews code, fixes bugs" },
    { "name": "my-analyst", "description": "Analyzes data, creates reports" }
  ]
}
```

**Routing Output**: `"my-coder"` or `"none"`

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
- ✅ No one can use another user's secrets
- ✅ No one can trigger another user's agents
- ✅ Clear ownership and billing attribution
- ✅ Per-user audit trail

**Requirement**: Slack users must link their VM0 accounts before using @VM0.

#### Secrets Management

Follow the Schedule pattern:
- Store encrypted secrets at bot configuration time
- Decrypt at runtime for each run
- Use `SECRETS_ENCRYPTION_KEY` with AES-256-GCM

### Data Model

#### New Table: `slack_workspaces`

Stores workspace-level OAuth tokens (one per workspace).

```sql
CREATE TABLE slack_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id VARCHAR(64) NOT NULL UNIQUE,  -- Slack team_id
  slack_workspace_name VARCHAR(255),
  slack_bot_token TEXT NOT NULL,                    -- Encrypted xoxb-* token
  slack_bot_user_id VARCHAR(64),                    -- Bot's user ID in Slack
  installed_by_vm0_user_id TEXT NOT NULL,           -- Who first installed
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
```

#### New Table: `slack_user_links`

Maps Slack users to VM0 accounts.

```sql
CREATE TABLE slack_user_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id VARCHAR(64) NOT NULL,
  slack_user_id VARCHAR(64) NOT NULL,
  vm0_user_id TEXT NOT NULL,                        -- Clerk user ID
  linked_at TIMESTAMP DEFAULT NOW() NOT NULL,

  UNIQUE(slack_workspace_id, slack_user_id)
);
```

#### New Table: `slack_agent_bindings`

Each user's agent bindings to a workspace.

```sql
CREATE TABLE slack_agent_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id VARCHAR(64) NOT NULL,
  vm0_user_id TEXT NOT NULL,                         -- Owner
  compose_id UUID NOT NULL REFERENCES agent_composes(id) ON DELETE CASCADE,

  -- For LLM Router
  description TEXT,                                  -- User-provided description for auto-routing

  -- Agent runtime configuration
  encrypted_secrets TEXT,
  vars JSONB,
  artifact_name VARCHAR(255),
  volume_versions JSONB,

  -- State
  enabled BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,

  -- One binding per (workspace, user, agent)
  UNIQUE(slack_workspace_id, vm0_user_id, compose_id)
);
```

#### New Table: `slack_thread_sessions`

Maps Slack threads to VM0 sessions for continue operations.

```sql
CREATE TABLE slack_thread_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id VARCHAR(64) NOT NULL,
  slack_channel_id VARCHAR(64) NOT NULL,
  slack_thread_ts VARCHAR(64) NOT NULL,
  slack_user_id VARCHAR(64) NOT NULL,                -- Slack user who started thread
  agent_binding_id UUID NOT NULL REFERENCES slack_agent_bindings(id) ON DELETE CASCADE,
  agent_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,

  UNIQUE(slack_workspace_id, slack_channel_id, slack_thread_ts)
);
```

#### New Table: `slack_link_sessions`

Temporary storage for account linking flow.

```sql
CREATE TABLE slack_link_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_token VARCHAR(255) NOT NULL UNIQUE,      -- Token in link URL
  slack_workspace_id VARCHAR(64) NOT NULL,
  slack_user_id VARCHAR(64) NOT NULL,
  vm0_user_id TEXT,                              -- Filled after VM0 OAuth
  status VARCHAR(32) DEFAULT 'pending',          -- pending | completed | expired
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
```

### API Endpoints

#### Account Linking (CLI Flow)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/cli/slack/link` | Initiate linking, return auth_url + link_token |
| GET | `/api/cli/slack/link/status` | Poll for linking completion |
| GET | `/api/slack/link/callback` | VM0 OAuth callback for linking |

#### Account Linking (Slack-initiated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/slack/link` | Landing page for link URL from Slack |
| POST | `/api/slack/link/complete` | Complete linking after VM0 OAuth |

#### Agent Binding

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agent/slack/bindings` | Bind agent to workspace |
| GET | `/api/agent/slack/bindings` | List my bound agents |
| PATCH | `/api/agent/slack/bindings/[id]` | Update agent binding |
| DELETE | `/api/agent/slack/bindings/[id]` | Remove agent from workspace |

#### Slack Webhooks (from Slack)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/slack/events` | Receive Slack events (app_mention) |
| POST | `/api/webhooks/slack/commands` | Receive slash commands (/vm0) |

### CLI Commands

```bash
# Link Slack account to VM0 (opens browser for Slack OAuth)
vm0 slack link

# Check link status
vm0 slack status

# Unlink Slack account
vm0 slack unlink [--workspace <name>]

# Bind agent to workspace
vm0 slack agent add <agent-name> [--workspace <name>] [--description <desc>] [--secrets KEY=value]

# List my bound agents
vm0 slack agent list [--workspace <name>]

# Update agent binding (secrets, description)
vm0 slack agent update <agent-name> [--workspace <name>] [--description <desc>] [--secrets KEY=value]

# Remove agent from workspace
vm0 slack agent remove <agent-name> [--workspace <name>]
```

### Account Linking Flow (CLI-initiated)

```
CLI                          VM0 Server                    Slack
 │                               │                           │
 │ POST /api/cli/slack/link      │                           │
 │ ─────────────────────────────►│                           │
 │                               │                           │
 │ { link_token, auth_url }      │                           │
 │ ◄─────────────────────────────│                           │
 │                               │                           │
 │ [Open browser to auth_url]    │                           │
 │ ═══════════════════════════════════════════════════════► │
 │                               │                           │
 │                               │  User signs in to Slack   │
 │                               │ ◄═══════════════════════ │
 │                               │                           │
 │                               │ GET /callback (identity)  │
 │                               │ ◄═════════════════════════│
 │                               │                           │
 │                               │ [Create user link:        │
 │                               │  slack_user ↔ vm0_user]   │
 │                               │                           │
 │ GET /api/cli/slack/link/status                            │
 │ ─────────────────────────────►│                           │
 │                               │                           │
 │ { status: "completed", workspace: "Acme Corp" }           │
 │ ◄─────────────────────────────│                           │
```

### Account Linking Flow (Slack-initiated)

```
Slack                        VM0 Server                    Browser
 │                               │                           │
 │ User @VM0 (not linked)        │                           │
 │ ─────────────────────────────►│                           │
 │                               │                           │
 │ Reply: "Link account: [url]"  │                           │
 │ ◄─────────────────────────────│                           │
 │                               │                           │
 │                               │ User clicks link          │
 │                               │ ◄═════════════════════════│
 │                               │                           │
 │                               │ GET /api/slack/link?token=│
 │                               │ [Show VM0 login page]     │
 │                               │ ═════════════════════════►│
 │                               │                           │
 │                               │ [User logs in to VM0]     │
 │                               │ ◄═════════════════════════│
 │                               │                           │
 │                               │ [Create user link]        │
 │                               │ [Show success page]       │
 │                               │ ═════════════════════════►│
```

### Webhook Processing Flow

```
1. POST /api/webhooks/slack/events
   {
     "team_id": "T12345",
     "event": { "type": "app_mention", "user": "U67890", "text": "@VM0 ...", "thread_ts": ... }
   }
   ↓
2. Respond HTTP 200 immediately (Slack 3-second requirement)
   ↓
3. Async processing:
   a. Find slack_user_link by (team_id, event.user)
      ├─ Not found → Reply "Please link your VM0 account: [link]", abort
      └─ Found → Get vm0_user_id
   b. Route to agent (using THIS USER's agents only):
      ┌─ Has thread_ts with existing session? → Use session's agent (continue)
      ├─ Message starts with agent name? → Use specified agent
      ├─ LLM Router on user's agents → Use matched agent
      └─ No match → Reply with user's agent list, abort
   c. Find slack_agent_binding for selected agent
   ↓
4. Create/continue run with user's binding secrets
   ↓
5. Wait for completion
   ↓
6. Post result to Slack thread via chat.postMessage
```

### Slash Command Processing

```
/vm0 list
   ↓
1. Find slack_user_link by (team_id, user_id)
   ├─ Not found → "Please link your VM0 account first"
   └─ Found → Get vm0_user_id
   ↓
2. List slack_agent_bindings for (workspace, vm0_user_id)
   ↓
3. Reply with THIS USER's agent list (ephemeral message)
```

## Technical Constraints

### Slack API Requirements

1. **3-second response**: Must acknowledge webhook within 3 seconds
2. **OAuth scopes needed**: `app_mentions:read`, `chat:write`, `commands`
3. **Event subscription**: `app_mention` event
4. **Slash command**: `/vm0` with subcommands (`list`)

### VM0 Slack App Setup (One-time)

VM0 needs to register a Slack App at api.slack.com:

| Setting | Value |
|---------|-------|
| App Name | VM0 |
| OAuth Redirect URL | `https://api.vm0.ai/api/slack/oauth/callback` |
| Bot Token Scopes | `app_mentions:read`, `chat:write`, `commands` |
| Event Request URL | `https://api.vm0.ai/api/webhooks/slack/events` |
| Subscribe to events | `app_mention` |
| Slash Commands | `/vm0` → `https://api.vm0.ai/api/webhooks/slack/commands` |

### Multi-tenant Considerations

- Single Slack App serves all workspaces
- Events routed by `(team_id, slack_user_id)` to correct VM0 user
- Each user's agents are isolated - LLM Router only sees that user's agents
- All responses appear as "@VM0" in Slack (single app identity)

## Security Considerations

1. **User isolation**: Each user triggers their own agents with their own secrets
2. **No cross-user access**: Users cannot see or trigger other users' agents
3. **Account linking required**: Unlinked Slack users cannot use @VM0
4. **Secret storage**: AES-256-GCM encryption for bot tokens and agent secrets
5. **OAuth state**: Use link_token as state parameter to prevent CSRF

## Out of Scope (Future)

1. Team/shared agents (all users see same agents)
2. Streaming responses to Slack
3. Multiple slash command subcommands (only `/vm0 list` for MVP)
4. Cross-workspace agent sharing

## Dependencies

- Existing: `schedule-service.ts` pattern for encrypted secrets
- Existing: `agent-session-service.ts` for session management
- Existing: `run-service.ts` for run orchestration
- Existing: CLI auth device code pattern for OAuth polling
- New: Slack Web API client for posting messages
- New: LLM Router service for agent selection (lightweight model call)

## References

- [Slack OAuth 2.0](https://api.slack.com/authentication/oauth-v2)
- [Slack Events API](https://api.slack.com/apis/events-api)
- Research document: `/tmp/deep-dive/slack-vm0-agent-bot/research.md`
- Innovate document: `/tmp/deep-dive/slack-vm0-agent-bot/innovate/create-slack-bot-flow.md`
