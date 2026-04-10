// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet } from "ccstate-react";
import {
  IconArrowUpRight,
  IconMessageCircle,
  IconSearch,
} from "@tabler/icons-react";
import { Card, CardContent, cn, Input } from "@vm0/ui";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { getCategories } from "./zero-ideation-data.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { currentAgentId$ } from "../../signals/agent.ts";
import {
  ideationActiveTab$,
  setIdeationActiveTab$,
  ideationSearchQuery$,
  setIdeationSearchQuery$,
} from "../../signals/zero-page/zero-ideation.ts";
export function ZeroIdeationPage() {
  const categories = getCategories().slice(0, 5);
  const activeTab = useGet(ideationActiveTab$);
  const setActiveTab = useSet(setIdeationActiveTab$);
  const searchQuery = useGet(ideationSearchQuery$);
  const setSearchQuery = useSet(setIdeationSearchQuery$);
  const navigate = useSet(detachedNavigateTo$);
  const agentId = useGet(currentAgentId$);

  const navigateToChat = () => {
    if (agentId) {
      navigate("/agents/:agentId/chat", { pathParams: { agentId: agentId } });
    } else {
      navigate("/");
    }
  };

  const baseCategories =
    activeTab === "all"
      ? categories
      : categories.filter((c) => {
          return c.id === activeTab;
        });
  const searchNeedle = searchQuery.trim().toLowerCase();
  const visibleCategories =
    searchNeedle.length === 0
      ? baseCategories
      : baseCategories
          .map((c) => {
            return {
              ...c,
              cases: c.cases.filter((u) => {
                return (
                  u.title.toLowerCase().includes(searchNeedle) ||
                  u.description.toLowerCase().includes(searchNeedle)
                );
              }),
            };
          })
          .filter((c) => {
            return c.cases.length > 0;
          });

  const handleSelectPrompt = (prompt: string) => {
    const searchParams = new URLSearchParams({ prompt });
    if (agentId) {
      navigate("/agents/:agentId/chat", {
        pathParams: { agentId: agentId },
        searchParams,
      });
    } else {
      navigate("/", { searchParams });
    }
  };

  const handleBack = () => {
    navigateToChat();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <IconMessageCircle size={14} stroke={1.5} className="shrink-0" />
          Chat
        </button>
        <span className="text-muted-foreground/40 select-none">/</span>
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
          Ideas &amp; Use Cases
        </span>
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-4 pb-8 sm:px-6">
          <div className="mx-auto w-full max-w-[900px]">
            <header className="bg-transparent pt-3 md:pt-6 pb-3">
              <h1 className="hidden md:block text-lg font-semibold tracking-tight text-foreground">
                Ideas &amp; Use Cases
              </h1>
              <p className="hidden md:block mt-1 text-sm text-muted-foreground leading-relaxed">
                Click any card to start a conversation. It could become an
                on-demand task, a recurring workflow, or a subagent.
              </p>
            </header>

            <div className="pt-2 pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className={cn(
                      "h-7 shrink-0 rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors cursor-pointer",
                      activeTab === "all"
                        ? "bg-muted text-foreground"
                        : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                    onClick={() => {
                      return setActiveTab("all");
                    }}
                  >
                    All
                  </button>
                  {categories.map((category) => {
                    return (
                      <button
                        key={category.id}
                        type="button"
                        className={cn(
                          "h-7 shrink-0 rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors cursor-pointer",
                          activeTab === category.id
                            ? "bg-muted text-foreground"
                            : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        )}
                        onClick={() => {
                          return setActiveTab(category.id);
                        }}
                      >
                        {category.title}
                      </button>
                    );
                  })}
                </div>
                <div className="relative w-full min-w-0 sm:max-w-[240px] sm:flex-1 sm:min-w-[12rem]">
                  <IconSearch
                    className="pointer-events-none absolute left-3 top-1/2 z-10 size-[14px] -translate-y-1/2 text-muted-foreground"
                    stroke={1.5}
                    aria-hidden
                  />
                  <Input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => {
                      return setSearchQuery(e.target.value);
                    }}
                    placeholder="Search"
                    className="pl-9"
                    aria-label="Search use cases"
                  />
                </div>
              </div>
            </div>

            <main className="pt-4">
              <div className="flex flex-col gap-6">
                {visibleCategories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No use cases match your search.
                  </p>
                ) : null}
                {visibleCategories.map((category) => {
                  return (
                    <section
                      key={category.id}
                      className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
                    >
                      <h2 className="text-lg font-semibold tracking-tight text-foreground">
                        {category.title}
                      </h2>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {category.cases.map((useCase) => {
                          return (
                            <Card
                              key={useCase.title}
                              className="zero-card cursor-pointer hover:bg-muted/30 transition-colors"
                              onClick={() => {
                                return handleSelectPrompt(useCase.prompt);
                              }}
                            >
                              <CardContent className="p-4 group relative">
                                <IconArrowUpRight
                                  size={14}
                                  stroke={2}
                                  className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
                                />
                                <p className="text-sm font-semibold text-foreground pr-5">
                                  {useCase.title}
                                </p>
                                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                                  {useCase.description}
                                </p>
                                {useCase.connectors &&
                                  useCase.connectors.length > 0 && (
                                    <div className="flex items-center gap-1.5 mt-2.5">
                                      {useCase.connectors.map((type) => {
                                        return (
                                          <span
                                            key={type}
                                            className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background"
                                          >
                                            <ConnectorIcon
                                              type={type}
                                              size={14}
                                            />
                                          </span>
                                        );
                                      })}
                                    </div>
                                  )}
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
