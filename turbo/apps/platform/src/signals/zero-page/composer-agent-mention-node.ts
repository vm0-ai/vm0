import { Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import {
  resolveAvatarSvgConfig,
  resolveAvatarUrl,
} from "../../views/zero-page/avatar-utils.ts";
import { avatarSvgLayerUrls } from "../../views/zero-page/avatar-svg-utils.ts";
import { serializeAgentMention } from "./composer-agent-suggestion-domain.ts";
import { AGENT_MENTION_NODE_NAME } from "./user-message-document-codec.ts";

interface AgentMentionAttributes {
  readonly agentId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

interface AgentMentionAvatarSource {
  readonly id: string;
  readonly avatarUrl: string | null;
}

export interface AgentMentionAvatarRuntime {
  readonly resolve: (agentId: string, fallback: string | null) => string | null;
  readonly replaceAgents: (agents: readonly AgentMentionAvatarSource[]) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createAgentMentionAvatarRuntime(): AgentMentionAvatarRuntime {
  let agents: readonly AgentMentionAvatarSource[] = [];
  const listeners = new Set<() => void>();
  return {
    resolve(agentId, fallback) {
      const agent = agents.find((candidate) => {
        return candidate.id === agentId;
      });
      return agent ? agent.avatarUrl : fallback;
    },
    replaceAgents(nextAgents) {
      agents = nextAgents;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function agentMentionAttributes(node: ProseMirrorNode): AgentMentionAttributes {
  const agentId: unknown = node.attrs.agentId;
  const name: unknown = node.attrs.name;
  const avatarUrl: unknown = node.attrs.avatarUrl;
  if (
    typeof agentId !== "string" ||
    typeof name !== "string" ||
    (avatarUrl !== null && typeof avatarUrl !== "string")
  ) {
    throw new Error("Agent mention node attributes are invalid");
  }
  return { agentId, name, avatarUrl };
}

export function agentMentionText(node: ProseMirrorNode): string {
  const { agentId, name } = agentMentionAttributes(node);
  return serializeAgentMention(agentId, name);
}

function renderAgentMentionAvatar(
  container: HTMLElement,
  avatarUrl: string | null,
): void {
  container.replaceChildren();
  const svgConfig = resolveAvatarSvgConfig(avatarUrl);
  if (svgConfig) {
    const urls = avatarSvgLayerUrls(svgConfig);
    const layers = document.createElement("span");
    layers.className = "absolute inset-0 scale-[1.25]";
    for (const src of [urls.head, urls.face, urls.hair]) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = src;
      image.className = "absolute inset-0 h-full w-full object-cover";
      layers.append(image);
    }
    container.append(layers);
    return;
  }

  const src = resolveAvatarUrl(avatarUrl);
  if (src) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = src;
    image.className = "h-full w-full object-cover";
    container.append(image);
  }
}

function createAgentMentionNodeView(
  node: ProseMirrorNode,
  className: string,
  avatarRuntime: AgentMentionAvatarRuntime,
): NodeView {
  const dom = document.createElement("span");
  dom.className = className;
  dom.contentEditable = "false";
  dom.style.outline = "none";
  dom.style.userSelect = "none";

  const avatar = document.createElement("span");
  avatar.className =
    "relative h-4 w-4 shrink-0 overflow-hidden rounded-full bg-muted";
  avatar.ariaHidden = "true";
  const name = document.createElement("span");
  name.className = "min-w-0 select-none truncate";
  dom.append(avatar, name);

  let currentNode = node;
  let currentAvatarUrl: string | null | undefined;
  function render(nextNode: ProseMirrorNode): void {
    const attributes = agentMentionAttributes(nextNode);
    const avatarUrl = avatarRuntime.resolve(
      attributes.agentId,
      attributes.avatarUrl,
    );
    dom.dataset.agentMention = attributes.agentId;
    dom.dataset.agentName = attributes.name;
    if (avatarUrl === null) {
      delete dom.dataset.agentAvatarUrl;
    } else {
      dom.dataset.agentAvatarUrl = avatarUrl;
    }
    name.textContent = attributes.name;
    if (avatarUrl !== currentAvatarUrl) {
      currentAvatarUrl = avatarUrl;
      renderAgentMentionAvatar(avatar, avatarUrl);
    }
  }
  render(node);
  const unsubscribe = avatarRuntime.subscribe(() => {
    render(currentNode);
  });

  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
      return true;
    },
    selectNode() {
      dom.dataset.selected = "";
    },
    deselectNode() {
      delete dom.dataset.selected;
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      unsubscribe();
    },
  };
}

export function createAgentMentionNode(
  className: string,
  avatarRuntime: AgentMentionAvatarRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: AGENT_MENTION_NODE_NAME,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return {
        agentId: { default: "" },
        name: { default: "" },
        avatarUrl: { default: null },
      };
    },
    parseHTML() {
      return [
        {
          tag: "span[data-agent-mention]",
          getAttrs: (element) => {
            return {
              agentId: element.dataset.agentMention ?? "",
              name: element.dataset.agentName ?? "",
              avatarUrl: element.dataset.agentAvatarUrl ?? null,
            };
          },
        },
      ];
    },
    renderHTML({ node }) {
      const { agentId, name, avatarUrl } = agentMentionAttributes(node);
      return [
        "span",
        {
          "data-agent-mention": agentId,
          "data-agent-name": name,
          ...(avatarUrl === null ? {} : { "data-agent-avatar-url": avatarUrl }),
          class: className,
        },
        name,
      ];
    },
    renderText({ node }) {
      return agentMentionText(node);
    },
    addNodeView() {
      return ({ node }) => {
        return createAgentMentionNodeView(node, className, avatarRuntime);
      };
    },
  });
}
