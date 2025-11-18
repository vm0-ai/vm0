# @vm0/sdk

TypeScript SDK for VM0 Agent Runtime.

## Installation

```bash
npm install @vm0/sdk
# or
pnpm add @vm0/sdk
```

## Quick Start

```typescript
import { AgentRuntime } from "@vm0/sdk";

// Create agent runtime
const agent = AgentRuntime.create(
  "your-agent-config-id",
  {
    userKey: "user-123",
  },
  {
    apiUrl: "https://api.vm0.dev",
    apiKey: "your-api-key",
  },
);

// Run agent
const runner = agent.run("Answer my question");

// Listen to events
runner.on("text", (event) => {
  console.log("Agent:", event.content);
});

runner.on("result", (event) => {
  console.log("Result:", event.content.result);
  console.log("Cost:", event.content.totalCostUsd);
});

// Wait for completion
const result = await runner.wait();
```

## Configuration

### Environment Variables

```bash
VM0_API_URL=https://api.vm0.dev
VM0_API_KEY=your_api_key_here
```

### Options

```typescript
AgentRuntime.create(agentConfigId, dynamicVars, {
  apiUrl: "https://api.vm0.dev",
  apiKey: "your-api-key",
  pollInterval: 1000, // Poll every 1 second
  timeout: 60000, // Timeout after 60 seconds
});
```

## Events

- `init` - Agent initialized
- `text` - Text output from agent
- `tool_use` - Agent is using a tool
- `tool_result` - Tool execution result
- `result` - Final result
- `error` - Error occurred
- `*` - All events (wildcard)

## API

### AgentRuntime

#### `static create(agentConfigId, dynamicVars?, config?)`

Create a new agent runtime.

#### `run(prompt)`

Run the agent with a prompt. Returns an `AgentRunner`.

### AgentRunner

#### `on(event, callback)`

Listen to events.

#### `wait()`

Wait for the agent to complete. Returns a promise that resolves with the final result.

#### `stop()`

Stop polling for events.

## License

Private
