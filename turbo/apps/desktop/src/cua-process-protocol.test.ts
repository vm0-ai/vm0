import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { cuaRequestSchema, readCuaFrames } from "./cua-process-protocol";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function channel(limit: number) {
  const accepted: unknown[] = [];
  let failures = 0;
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const connected = new Promise<Socket>((resolve) =>
    server.once("connection", resolve),
  );
  const sender = connect(address.port, "127.0.0.1");
  const receiver = await connected;
  readCuaFrames(
    receiver,
    limit,
    (value) => accepted.push(cuaRequestSchema.parse(value)),
    () => failures++,
  );
  cleanup.push(() => {
    sender.destroy();
    receiver.destroy();
    server.close();
  });
  return { sender, receiver, accepted, failures: () => failures };
}

const request = {
  generation: 1,
  id: 1,
  expiresAt: 100,
  operation: {
    method: "tool",
    input: { name: "launch_app", args: { bundle_id: "test.应用" } },
  },
};

it("accepts a bounded fixed request across a fragmented UTF-8 stream", async () => {
  const peer = await channel(1024);
  const frame = Buffer.from(JSON.stringify(request) + "\n");
  const split = frame.indexOf(Buffer.from("应")) + 1;
  peer.sender.write(frame.subarray(0, split));
  await once(peer.receiver, "data");
  expect(peer.accepted).toEqual([]);
  peer.sender.write(frame.subarray(split));
  await expect.poll(() => peer.accepted.length).toBe(1);
  expect(peer.accepted).toEqual([request]);
});

it.each([
  { ...request, environment: { TOKEN: "forbidden" } },
  { ...request, operation: { method: "eval", input: { script: "forbidden" } } },
  {
    ...request,
    operation: {
      method: "tool",
      input: {
        name: "launch_app",
        args: { bundle_id: "test.app", path: "/forbidden" },
      },
    },
  },
])(
  "closes admission after a forbidden request and never accepts a following frame",
  async (invalid) => {
    const peer = await channel(1024);
    peer.sender.write(
      JSON.stringify(invalid) + "\n" + JSON.stringify(request) + "\n",
    );
    await expect.poll(peer.failures).toBe(1);
    peer.sender.write(JSON.stringify(request) + "\n");
    await once(peer.receiver, "data");
    expect(peer.accepted).toEqual([]);
  },
);

it("rejects an over-limit unterminated frame before parsing and retains the failure fence", async () => {
  const peer = await channel(128);
  peer.sender.write(Buffer.alloc(129, 32));
  await expect.poll(peer.failures).toBe(1);
  peer.sender.write("\n" + JSON.stringify(request) + "\n");
  await once(peer.receiver, "data");
  expect(peer.failures()).toBe(1);
  expect(peer.accepted).toEqual([]);
});
