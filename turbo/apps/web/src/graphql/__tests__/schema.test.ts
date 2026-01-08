import { describe, it, expect } from "vitest";
import { schema } from "../schema";

describe("GraphQL Schema", () => {
  it("should build a valid schema", () => {
    expect(schema).toBeDefined();
  });

  it("should have Query type with run field", () => {
    const queryType = schema.getQueryType();
    expect(queryType).toBeDefined();
    expect(queryType?.getFields().run).toBeDefined();
  });

  it("should have Mutation type with createRun field", () => {
    const mutationType = schema.getMutationType();
    expect(mutationType).toBeDefined();
    expect(mutationType?.getFields().createRun).toBeDefined();
  });

  it("should have Subscription type with runEvents field", () => {
    const subscriptionType = schema.getSubscriptionType();
    expect(subscriptionType).toBeDefined();
    expect(subscriptionType?.getFields().runEvents).toBeDefined();
  });

  it("should have Run type with expected fields", () => {
    const runType = schema.getType("Run");
    expect(runType).toBeDefined();

    if (runType && "getFields" in runType) {
      const fields = runType.getFields();
      expect(fields.id).toBeDefined();
      expect(fields.status).toBeDefined();
      expect(fields.prompt).toBeDefined();
      expect(fields.createdAt).toBeDefined();
    }
  });

  it("should have RunStatus enum", () => {
    const runStatusType = schema.getType("RunStatus");
    expect(runStatusType).toBeDefined();
  });

  it("should have Agent type", () => {
    const agentType = schema.getType("Agent");
    expect(agentType).toBeDefined();
  });

  it("should have CreateRunPayload type", () => {
    const payloadType = schema.getType("CreateRunPayload");
    expect(payloadType).toBeDefined();
  });
});
