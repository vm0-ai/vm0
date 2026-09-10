import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ThinkingMessages } from "../thinking-messages";

const messages = [
  { id: "prepare", text: "Preparing the launch checklist" },
  { id: "review", text: "Reviewing the release evidence" },
  { id: "check", text: "Checking the remaining tasks" },
];

test("cycles through the messages and returns to the first", async () => {
  render(<ThinkingMessages messages={messages} intervalMs={100} />);
  expect(screen.getByText(messages[0]!.text)).toBeVisible();
  await expect(screen.findByText(messages[1]!.text)).resolves.toBeVisible();
  await expect(screen.findByText(messages[2]!.text)).resolves.toBeVisible();
  await expect(screen.findByText(messages[0]!.text)).resolves.toBeVisible();
});

test("an equivalent refresh keeps the current message and rotation", async () => {
  const view = render(
    <ThinkingMessages messages={messages} intervalMs={100} />,
  );
  await expect(screen.findByText(messages[1]!.text)).resolves.toBeVisible();
  view.rerender(
    <ThinkingMessages
      messages={messages.map((message) => {
        return { ...message };
      })}
      intervalMs={100}
    />,
  );
  expect(screen.getByText(messages[1]!.text)).toBeVisible();
  await expect(screen.findByText(messages[2]!.text)).resolves.toBeVisible();
});

test("replacing or clearing the batch never displays removed messages", async () => {
  const view = render(
    <ThinkingMessages
      messages={messages}
      intervalMs={100}
      fallback="Thinking..."
    />,
  );
  await expect(screen.findByText(messages[1]!.text)).resolves.toBeVisible();
  view.rerender(
    <ThinkingMessages
      messages={[messages[2]!]}
      intervalMs={100}
      fallback="Thinking..."
    />,
  );
  expect(screen.getByText(messages[2]!.text)).toBeVisible();
  expect(screen.queryByText(messages[1]!.text)).not.toBeInTheDocument();
  view.rerender(<ThinkingMessages messages={[]} fallback="Thinking..." />);
  expect(screen.getByText("Thinking...")).toBeVisible();
  view.rerender(
    <ThinkingMessages
      messages={[{ id: "next", text: "Preparing the next task" }]}
    />,
  );
  expect(screen.getByText("Preparing the next task")).toBeVisible();
});

test("a different run starts with its own first message", async () => {
  const view = render(
    <ThinkingMessages key="first-run" messages={messages} intervalMs={100} />,
  );
  await expect(screen.findByText(messages[1]!.text)).resolves.toBeVisible();
  view.rerender(
    <ThinkingMessages key="next-run" messages={messages} intervalMs={100} />,
  );
  expect(screen.getByText(messages[0]!.text)).toBeVisible();
});
