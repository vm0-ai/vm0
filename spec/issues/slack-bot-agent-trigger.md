# Slack Bot for VM0 Agent Run & Continue

## Summary

Enable users to trigger VM0 agent runs and continues through @bot mentions in Slack. This feature allows users to create Slack bots on the VM0 platform that bind to an agent compose with pre-configured secrets and variables.

## Motivation

Users want to interact with their VM0 agents directly from Slack without leaving their communication workflow. This is similar to the existing schedule capability but triggered by user mentions instead of cron expressions.

## User Stories

1. As a user, I want to create a Slack bot on VM0 that binds to one of my agents
2. As a user, I want to @bot in a Slack channel to start a new agent run
3. As a user, I want to continue a conversation by replying in a Slack thread
4. As a user, I want to see the agent's result as a reply in the thread

## Detailed Design

### Core Concepts

#### Thread-to-Session Mapping
- Main message @bot → Creates new VM0 session
- Thread reply @bot → Continues existing session
- Use Slack's `thread_ts` to distinguish between new runs and continues

#### Permission Model (MVP: Creator-Only)

**Security Constraint**: Only the bot creator can trigger the bot.

Rationale:
- Allowing anyone in channel to @bot would use creator's secrets without consent
- Creator's API keys, database passwords, etc. should not be exposed to strangers
- This differs from Schedule (which is only triggered by cron, not exposed to external users)

Future expansion options:
- Allowlist: `allowedSlackUserIds: ["U123", "U456"]`
- Linked users: Require VM0 account binding
- Per-user secrets: Each user provides their own credentials

#### Secrets Management

Follow the Schedule pattern:
- Store encrypted secrets at bot configuration time
- Decrypt at runtime for each run
- Use `SECRETS_ENCRYPTION_KEY` with AES-256-GCM

### Data Model

#### New Table: `slack_bots`

```sql
CREATE TABLE slack_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,                    -- Bot creator (Clerk user ID)
  compose_id UUID NOT NULL REFERENCES agent_composes(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,

  -- Slack App credentials (encrypted)
  slack_bot_token TEXT NOT NULL,            -- xoxb-* token, encrypted
  slack_signing_secret TEXT NOT NULL,       -- For webhook verification, encrypted

  -- Agent runtime configuration
  encrypted_secrets TEXT,                   -- Same pattern as schedules
  vars JSONB,
  artifact_name VARCHAR(255),
  volume_versions JSONB,

  -- State
  enabled BOOLEAN DEFAULT false,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, name)
);
```

#### New Table: `slack_thread_sessions`

Maps Slack threads to VM0 sessions for continue operations.

```sql
CREATE TABLE slack_thread_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_bot_id UUID NOT NULL REFERENCES slack_bots(id) ON DELETE CASCADE,
  slack_channel_id VARCHAR(64) NOT NULL,
  slack_thread_ts VARCHAR(64) NOT NULL,     -- Thread timestamp (unique per thread)
  agent_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,

  created_at TIMESTAMP DEFAULT NOW() NOT NULL,

  UNIQUE(slack_bot_id, slack_channel_id, slack_thread_ts)
);
```

### API Endpoints

#### Slack Bot Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agent/slack-bots` | Create/update Slack bot |
| GET | `/api/agent/slack-bots` | List user's Slack bots |
| GET | `/api/agent/slack-bots/[name]` | Get bot by name |
| DELETE | `/api/agent/slack-bots/[name]` | Delete bot |
| POST | `/api/agent/slack-bots/[name]/enable` | Enable bot |
| POST | `/api/agent/slack-bots/[name]/disable` | Disable bot |

#### Slack Webhook

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/slack/events` | Receive Slack events (app_mention) |

### Webhook Processing Flow

```
1. POST /api/webhooks/slack/events
   ↓
2. Verify Slack signature (signing secret)
   ↓
3. Respond HTTP 200 immediately (Slack 3-second requirement)
   ↓
4. Async processing:
   a. Parse event (app_mention)
   b. Find slack_bot by bot_user_id
   c. Verify trigger permission (creator only for MVP)
   d. Check thread_ts:
      - No thread_ts or thread_ts == ts → New session
      - Has thread_ts and thread_ts != ts → Continue existing session
   ↓
5. Create/continue run:
   a. Decrypt bot's secrets
   b. Build execution context
   c. Dispatch run
   ↓
6. Wait for completion (poll or subscribe to Ably)
   ↓
7. Post result to Slack thread via chat.postMessage
```

### CLI Commands

```bash
# Deploy a Slack bot
vm0 slack deploy <agent-name> \
  --name "my-slack-bot" \
  --bot-token "xoxb-..." \
  --signing-secret "..." \
  --secrets KEY=value \
  --vars KEY=value

# List Slack bots
vm0 slack list

# Enable/disable
vm0 slack enable <name>
vm0 slack disable <name>

# Delete
vm0 slack delete <name>
```

## Technical Constraints

### Slack API Requirements

1. **3-second response**: Must acknowledge webhook within 3 seconds
2. **Signing secret verification**: Validate `X-Slack-Signature` header
3. **Bot token scopes needed**: `app_mentions:read`, `chat:write`, `channels:history`

### VM0 Architecture Constraints

1. **Session secrets**: Sessions don't store secret values (security design)
   - Solution: Store encrypted secrets in `slack_bots` table (like schedules)

2. **User ownership**: All runs require `userId`
   - Solution: Use bot creator's userId for all runs

3. **No agent sharing**: Cannot run another user's agent
   - Not a blocker for MVP (creator-only model)

## Security Considerations

1. **Trigger permission**: Only bot creator can @bot (MVP)
2. **Secret storage**: AES-256-GCM encryption at rest
3. **Webhook verification**: Validate Slack signing secret
4. **Token storage**: Bot tokens encrypted like other credentials

## Out of Scope (Future)

1. Allowlist-based trigger permissions
2. VM0 account linking for Slack users
3. Per-user secrets
4. Multi-workspace support for single bot
5. Streaming responses to Slack

## Dependencies

- Existing: `schedule-service.ts` pattern for encrypted secrets
- Existing: `agent-session-service.ts` for session management
- Existing: `run-service.ts` for run orchestration
- New: Slack SDK or raw API calls for posting messages

## References

- Research document: `/tmp/deep-dive/slack-vm0-agent-bot/research.md`
- Schedule service: `/turbo/apps/web/src/lib/schedule/schedule-service.ts`
- Session service: `/turbo/apps/web/src/lib/agent-session/agent-session-service.ts`
