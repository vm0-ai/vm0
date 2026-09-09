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

/**
 * The transform placing the artwork inside the avatar box. That is the box's
 * only element child, one level above the wrapper carrying the chin-baseline
 * scale, so reading it here keeps the two transforms apart.
 */
function avatarFramingTransform(agentId: string): string {
  const box = agentCard(agentId).querySelector<HTMLElement>('[role="img"]');
  const artwork = box?.firstElementChild;
  if (!(artwork instanceof HTMLElement)) {
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

  // Both are centered: the flat-haired artwork sits far below the middle of its
  // canvas, so it moves up much further than the one that already fills it.
  expect(flat).toMatch(/translateY\(-15\.26/u);
  expect(tall).toMatch(/translateY\(-0\.83/u);

  // The smaller artwork grows, the larger one shrinks, and neither is scaled
  // hard enough to make its face the odd one out.
  const flatScale = framingScale(flat);
  const tallScale = framingScale(tall);
  expect(flatScale).toBeCloseTo(1.151, 3);
  expect(tallScale).toBeCloseTo(0.967, 3);

  // What the framing is for: as drawn these two differ by 1.42x, which is what
  // makes a row of cards look uneven. Framed, they differ by less than 1.2x.
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
