import { beforeEach, describe, expect, it, vi } from "vitest";
import { Realtime, resetAblySubscriptions } from "../ably.ts";
import {
  createChatMessage,
  createChatRun,
  updateChatRun,
} from "../mock-helpers.ts";

describe("mock-helpers chat triggers", () => {
  let channel: ReturnType<InstanceType<typeof Realtime>["channels"]["get"]>;

  beforeEach(() => {
    resetAblySubscriptions();
    const ably = new Realtime();
    channel = ably.channels.get("chat");
  });

  it("createChatMessage fires the chatThreadMessageCreated topic", async () => {
    const cb = vi.fn();
    await channel.subscribe("chatThreadMessageCreated:thread-1", cb);
    createChatMessage("thread-1");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("createChatRun fires the chatThreadRunCreated topic", async () => {
    const cb = vi.fn();
    await channel.subscribe("chatThreadRunCreated:thread-1", cb);
    createChatRun("thread-1");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("updateChatRun fires the chatThreadRunUpdated topic", async () => {
    const cb = vi.fn();
    await channel.subscribe("chatThreadRunUpdated:thread-1", cb);
    updateChatRun("thread-1");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("createChatMessage does not fire run topics", async () => {
    const runCreated = vi.fn();
    const runUpdated = vi.fn();
    await channel.subscribe("chatThreadRunCreated:thread-1", runCreated);
    await channel.subscribe("chatThreadRunUpdated:thread-1", runUpdated);
    createChatMessage("thread-1");
    expect(runCreated).not.toHaveBeenCalled();
    expect(runUpdated).not.toHaveBeenCalled();
  });

  it("createChatRun does not fire message or run-updated topics", async () => {
    const msgCreated = vi.fn();
    const runUpdated = vi.fn();
    await channel.subscribe("chatThreadMessageCreated:thread-1", msgCreated);
    await channel.subscribe("chatThreadRunUpdated:thread-1", runUpdated);
    createChatRun("thread-1");
    expect(msgCreated).not.toHaveBeenCalled();
    expect(runUpdated).not.toHaveBeenCalled();
  });

  it("updateChatRun does not fire message or run-created topics", async () => {
    const msgCreated = vi.fn();
    const runCreated = vi.fn();
    await channel.subscribe("chatThreadMessageCreated:thread-1", msgCreated);
    await channel.subscribe("chatThreadRunCreated:thread-1", runCreated);
    updateChatRun("thread-1");
    expect(msgCreated).not.toHaveBeenCalled();
    expect(runCreated).not.toHaveBeenCalled();
  });

  it("helpers use the provided threadId for topic interpolation", async () => {
    const cbForAbc = vi.fn();
    const cbForXyz = vi.fn();
    await channel.subscribe("chatThreadMessageCreated:abc", cbForAbc);
    await channel.subscribe("chatThreadMessageCreated:xyz", cbForXyz);
    createChatMessage("abc");
    expect(cbForAbc).toHaveBeenCalledOnce();
    expect(cbForXyz).not.toHaveBeenCalled();
  });
});
