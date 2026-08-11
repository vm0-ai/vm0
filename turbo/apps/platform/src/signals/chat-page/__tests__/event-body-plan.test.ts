import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import {
  markdownCardKey,
  parseMarkdownTree,
} from "../../../lib/markdown/pipeline.ts";
import { createConnectorCardSignalsRegistry } from "../connector-action-block.ts";
import type { MarkdownCardRef } from "../markdown-card-ref.ts";
import {
  cardSlotUrl,
  eventBodyPlan,
  type CardDescriptorBlock,
} from "../parse-body-blocks.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const CONNECTOR_URL = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;

const store = createStore();
const connectorRegistry = createConnectorCardSignalsRegistry();

function connectorRef(descriptor: CardDescriptorBlock): MarkdownCardRef {
  if (descriptor.type !== "connector-action") {
    throw new Error(`expected a connector descriptor, got ${descriptor.type}`);
  }
  return {
    kind: "connector-action",
    signals: store.set(connectorRegistry.register$, descriptor.descriptor),
  };
}

describe("eventBodyPlan", () => {
  it("plans one document with the card standing on its own link paragraph", () => {
    const plan = eventBodyPlan(`before\n\n${CONNECTOR_URL}\n\nafter`, {
      previews: true,
    });

    expect(
      plan.descriptors.map((descriptor) => {
        return descriptor.type;
      }),
    ).toStrictEqual(["connector-action"]);
    expect(plan.treeSource).toBe(
      `before\n\n[${CONNECTOR_URL}](<${CONNECTOR_URL}>)\n\nafter`,
    );
  });

  it("keeps an inline label in prose and plans the card after it", () => {
    const plan = eventBodyPlan(
      `Please [connect GitHub](${CONNECTOR_URL}) first.`,
      { previews: true },
    );

    expect(plan.treeSource).toBe(
      `Please connect GitHub first.\n\n[${CONNECTOR_URL}](<${CONNECTOR_URL}>)`,
    );
  });

  it("plans a body without cards as the prose itself", () => {
    const plan = eventBodyPlan("just some **prose**", { previews: true });

    expect(plan.descriptors).toStrictEqual([]);
    expect(plan.treeSource).toBe("just some **prose**");
  });
});

describe("card slots in the tree", () => {
  it("replaces a registered slot with a card node and keeps prose around it", () => {
    const plan = eventBodyPlan(`before\n\n${CONNECTOR_URL}\n\nafter`, {
      previews: true,
    });
    const ref = connectorRef(plan.descriptors[0]!);
    const cards = new Map([
      [markdownCardKey(cardSlotUrl(plan.descriptors[0]!)), ref],
    ]);

    const tree = parseMarkdownTree(plan.treeSource, {
      mathEnabled: true,
      mermaidScope: "plan",
      cards,
    });

    const kinds = tree.children
      .filter((node) => {
        return node.type === "element";
      })
      .map((node) => {
        return node.data?.card ? "card" : node.tagName;
      });
    expect(kinds).toStrictEqual(["p", "card", "p"]);
    const cardNode = tree.children.find((node) => {
      return node.type === "element" && node.data?.card !== undefined;
    });
    expect(cardNode?.type === "element" && cardNode.data?.card).toBe(ref);
  });

  it("keeps an unresolved slot as an ordinary link", () => {
    const plan = eventBodyPlan(CONNECTOR_URL, { previews: true });

    const tree = parseMarkdownTree(plan.treeSource, {
      mathEnabled: true,
      mermaidScope: "plan",
      cards: new Map(),
    });

    const paragraph = tree.children.find((node) => {
      return node.type === "element" && node.tagName === "p";
    });
    expect(paragraph).toBeDefined();
    const anchor =
      paragraph?.type === "element" ? paragraph.children[0] : undefined;
    expect(anchor?.type === "element" && anchor.tagName).toBe("a");
  });

  it("does not mistake a quoted slot inside other prose for a card", () => {
    const tree = parseMarkdownTree(
      `see [${CONNECTOR_URL}](<${CONNECTOR_URL}>) inline`,
      {
        mathEnabled: true,
        mermaidScope: "plan",
        cards: new Map([
          [
            markdownCardKey(CONNECTOR_URL),
            connectorRef(
              eventBodyPlan(CONNECTOR_URL, { previews: true }).descriptors[0]!,
            ),
          ],
        ]),
      },
    );

    const paragraph = tree.children.find((node) => {
      return node.type === "element" && node.tagName === "p";
    });
    expect(paragraph?.type === "element" && paragraph.children.length).toBe(3);
  });
});
