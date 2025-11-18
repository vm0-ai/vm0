import { AgentRuntime } from "../index";

async function main() {
  // Create runtime
  const agent = AgentRuntime.create(
    "cfg-example-123",
    {
      userKey: "user-456",
    },
    {
      apiUrl: "http://localhost:3000",
      apiKey: "dev-key-123",
    },
  );

  // Run agent
  const runner = agent.run("Analyze the codebase and summarize findings");

  // Listen to all events
  runner.on("*", (event) => {
    console.log(`[${event.type}]`, event);
  });

  // Listen to specific events
  runner.on("text", (event) => {
    console.log("Agent says:", event.content);
  });

  runner.on("tool_use", (event) => {
    console.log(`Using ${event.tool}:`, event.params);
  });

  runner.on("result", (event) => {
    console.log("\n=== Final Result ===");
    console.log("Success:", event.content.success);
    console.log("Result:", event.content.result);
    console.log("Duration:", event.content.durationMs, "ms");
    console.log("Turns:", event.content.numTurns);
    console.log("Cost: $", event.content.totalCostUsd);
    console.log("Tokens:", event.content.usage);
  });

  // Handle errors
  runner.on("error", (error: Error) => {
    console.error("Error:", error.message);
  });

  // Wait for completion
  try {
    const result = await runner.wait();
    console.log("\nDone!", result);
  } catch (error) {
    console.error("Failed:", error);
    process.exit(1);
  }
}

main();
