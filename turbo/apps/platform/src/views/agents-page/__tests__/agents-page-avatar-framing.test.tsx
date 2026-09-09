/**
 * Boundary exception, per `docs/testing/testing-external-behavior.md`.
 *
 * These cases are set up entirely through the production page — the real
 * Agents route, the real agent list, and a real feature-switch override — but
 * they cannot be verified through it. Avatar framing has no page-observable
 * result: it is a transform whose only effect is the rendered size of the
 * artwork, and jsdom performs no layout, so nothing a user could see changes in
 * the DOM. The applied transform is the only available evidence.
 *
 * The case is still worth testing because the whole point of the framing rule
 * is that two avatars stop differing in size, and a wrong scale is silent —
 * every layer still loads and every element still renders. So the assertions
 * read the artwork through the `AVATAR_ARTWORK_SLOT` hook rather than the DOM
 * shape around it, and check the relationship the rule guarantees rather than
 * the exact numbers that happen to produce it.
 */
import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const FLAT_HAIR_AGENT_ID = "c0000000-0000-4000-a000-000000000021";
const TALL_HAIR_AGENT_ID = "c0000000-0000-4000-a000-000000000022";
const LEGACY_AGENT_ID = "c0000000-0000-4000-a000-000000000023";

/**
 * The share of the avatar box each artwork covers as drawn, before any framing.
 * These are properties of the composer assets — the flattest hair leaves the
 * canvas's whole forehead margin empty, the tallest fills it — and they are what
 * makes one agent card look larger than the next.
 */
const FLAT_HAIR_SHIPPED_FILL = 264 / 380;
const TALL_HAIR_SHIPPED_FILL = 373.6826 / 380;

function agent(agentId: string, avatarUrl: string): AgentResponse {
  return {
    agentId,
    ownerId: "test-user-123",
    description: null,
    displayName: agentId,
    sound: null,
    avatarUrl,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
}

const FLAT_HAIR_AVATAR_URL = avatarComposerUrl({
  face: "round",
  hair: "geometric-long",
  expression: "neutral-smile",
  skin: "gold",
  hairColor: "black",
  sweater: "blue",
});

const TALL_HAIR_AVATAR_URL = avatarComposerUrl({
  face: "square",
  hair: "high-bun",
  expression: "happy",
  skin: "deep",
  hairColor: "brown",
  sweater: "yellow",
});

function agentCard(agentId: string): HTMLElement {
  const card = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === `/agents/${agentId}`;
  });
  if (!card) {
    throw new Error(`${agentId} agent card not found`);
  }
  return card;
}

/** The transform placing the artwork inside the avatar box. */
function avatarFramingTransform(agentId: string): string {
  const artwork = agentCard(agentId).querySelector<HTMLElement>(
    "[data-avatar-artwork]",
  );
  if (!artwork) {
    throw new Error(`${agentId} avatar artwork not found`);
  }
  return artwork.style.transform;
}

function framingScale(transform: string): number {
  const match = /scale\(([\d.]+)\)/u.exec(transform);
  if (!match?.[1]) {
    throw new Error(`No scale in transform: ${transform}`);
  }
  return Number(match[1]);
}

function centeringOffset(transform: string): number {
  const match = /translateY\((-?[\d.]+)%\)/u.exec(transform);
  if (!match?.[1]) {
    throw new Error(`No vertical offset in transform: ${transform}`);
  }
  return Number(match[1]);
}

async function setupAgentsPage(
  agents: readonly AgentResponse[],
  framing: boolean,
): Promise<void> {
  context.mocks.data.agents([...agents]);
  context.mocks.data.onboardingStatus({
    defaultAgentId: agents[0]?.agentId ?? null,
  });
  await setupPage({
    context,
    path: "/agents",
    featureSwitches: {
      [FeatureSwitchKey.AvatarFraming]: framing,
    },
  });
  await waitFor(() => {
    expect(agentCard(agents[0]!.agentId)).toBeInTheDocument();
  });
}

test("Leave composer avatars on their drawn placement while framing is off", async () => {
  await setupAgentsPage(
    [
      agent(FLAT_HAIR_AGENT_ID, FLAT_HAIR_AVATAR_URL),
      agent(TALL_HAIR_AGENT_ID, TALL_HAIR_AVATAR_URL),
    ],
    false,
  );

  expect(avatarFramingTransform(FLAT_HAIR_AGENT_ID)).toBe("");
  expect(avatarFramingTransform(TALL_HAIR_AGENT_ID)).toBe("");
});

test("Center each composer avatar and pull the cast toward one size", async () => {
  await setupAgentsPage(
    [
      agent(FLAT_HAIR_AGENT_ID, FLAT_HAIR_AVATAR_URL),
      agent(TALL_HAIR_AGENT_ID, TALL_HAIR_AVATAR_URL),
    ],
    true,
  );

  const flat = avatarFramingTransform(FLAT_HAIR_AGENT_ID);
  const tall = avatarFramingTransform(TALL_HAIR_AGENT_ID);

  // Both move up, because both artworks hang below the middle of their canvas.
  // The flat-haired one leaves the whole forehead margin empty, so it has much
  // further to travel than the one whose bun already fills that margin.
  expect(centeringOffset(flat)).toBeLessThan(0);
  expect(centeringOffset(tall)).toBeLessThan(0);
  expect(centeringOffset(flat)).toBeLessThan(centeringOffset(tall));

  // The smaller artwork grows and the larger one shrinks, and neither moves far
  // enough to make its face the odd one out.
  const flatScale = framingScale(flat);
  const tallScale = framingScale(tall);
  expect(flatScale).toBeGreaterThan(1);
  expect(tallScale).toBeLessThan(1);
  expect(flatScale).toBeLessThan(1.2);
  expect(tallScale).toBeGreaterThan(0.9);

  // What the framing is for: as drawn these two differ by more than 1.4x, which
  // is what makes a row of cards look uneven. Framed, they differ by under 1.2x.
  const shippedRatio = TALL_HAIR_SHIPPED_FILL / FLAT_HAIR_SHIPPED_FILL;
  const framedRatio =
    (TALL_HAIR_SHIPPED_FILL * tallScale) / (FLAT_HAIR_SHIPPED_FILL * flatScale);
  expect(shippedRatio).toBeGreaterThan(1.4);
  expect(framedRatio).toBeLessThan(1.2);
});

test("Keep legacy avatars on the scale they already shipped with", async () => {
  await setupAgentsPage([agent(LEGACY_AGENT_ID, "svg:r3s2h4c1f5h")], true);

  expect(avatarFramingTransform(LEGACY_AGENT_ID)).toBe("scale(1.25)");
});
