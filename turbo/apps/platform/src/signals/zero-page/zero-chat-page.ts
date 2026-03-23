import { command, computed, state } from "ccstate";

// ---------------------------------------------------------------------------
// Demo / landing page local UI state for ZeroChatPage
// ---------------------------------------------------------------------------

const INITIAL_TAGLINE_INDEX = Math.floor(Math.random() * 18);

const internalInput$ = state("");
export const chatPageInput$ = computed((get) => get(internalInput$));
export const setChatPageInput$ = command(({ set }, value: string) => {
  set(internalInput$, value);
});

const internalConversationActive$ = state(false);
export const chatPageConversationActive$ = computed((get) =>
  get(internalConversationActive$),
);
export const setChatPageConversationActive$ = command(
  ({ set }, value: boolean) => {
    set(internalConversationActive$, value);
  },
);

const internalStreamedCount$ = state(0);
export const chatPageStreamedCount$ = computed((get) =>
  get(internalStreamedCount$),
);

const internalConversationEndEl$ = state<HTMLDivElement | null>(null);
export const setChatPageConversationEndEl$ = command(
  ({ set }, el: HTMLDivElement | null) => {
    set(internalConversationEndEl$, el);
  },
);

const internalSubAgentListEl$ = state<HTMLDivElement | null>(null);
export const setChatPageSubAgentListEl$ = command(
  ({ set }, el: HTMLDivElement | null) => {
    set(internalSubAgentListEl$, el);
  },
);

const internalApproveDone$ = state(false);
export const chatPageApproveDone$ = computed((get) =>
  get(internalApproveDone$),
);
export const setChatPageApproveDone$ = command(({ set }, value: boolean) => {
  set(internalApproveDone$, value);
});

const internalSelectedOption$ = state<string | null>(null);
export const chatPageSelectedOption$ = computed((get) =>
  get(internalSelectedOption$),
);
export const setChatPageSelectedOption$ = command(
  ({ set }, value: string | null) => {
    set(internalSelectedOption$, value);
  },
);

const internalTeamPersonalChoice$ = state<"team" | "personal" | null>(null);
export const chatPageTeamPersonalChoice$ = computed((get) =>
  get(internalTeamPersonalChoice$),
);
export const setChatPageTeamPersonalChoice$ = command(
  ({ set }, value: "team" | "personal" | null) => {
    set(internalTeamPersonalChoice$, value);
  },
);

const internalConnectorConnected$ = state(false);
export const chatPageConnectorConnected$ = computed((get) =>
  get(internalConnectorConnected$),
);
export const setChatPageConnectorConnected$ = command(
  ({ set }, value: boolean) => {
    set(internalConnectorConnected$, value);
  },
);

const internalCommandAllowed$ = state(false);
export const chatPageCommandAllowed$ = computed((get) =>
  get(internalCommandAllowed$),
);
export const setChatPageCommandAllowed$ = command(({ set }, value: boolean) => {
  set(internalCommandAllowed$, value);
});

const internalShowSubAgentList$ = state(false);
export const chatPageShowSubAgentList$ = computed((get) =>
  get(internalShowSubAgentList$),
);

const internalTaglineIndex$ = state(INITIAL_TAGLINE_INDEX);
export const chatPageTaglineIndex$ = computed((get) =>
  get(internalTaglineIndex$),
);

/** Toggle sub-agent list visibility with auto-scroll when opening. */
export const toggleChatPageSubAgentList$ = command(({ get, set }) => {
  const current = get(internalShowSubAgentList$);
  set(internalShowSubAgentList$, !current);
  if (!current) {
    window.requestAnimationFrame(() => {
      const el = get(internalSubAgentListEl$);
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
    });
  }
});
