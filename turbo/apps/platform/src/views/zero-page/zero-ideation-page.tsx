import { useState } from "react";
import { IconArrowUpRight, IconMessageCircle } from "@tabler/icons-react";
import { Card, CardContent, cn } from "@vm0/ui";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { getCategories } from "./zero-ideation-data.ts";

export { getRandomPrompts } from "./zero-ideation-data.ts";

interface ZeroIdeationPageProps {
  onBack: () => void;
  onSelectPrompt: (prompt: string) => void;
}

export function ZeroIdeationPage({
  onBack,
  onSelectPrompt,
}: ZeroIdeationPageProps) {
  const categories = getCategories();
  const [activeTab, setActiveTab] = useState("all");

  const visibleCategories =
    activeTab === "all"
      ? categories
      : categories.filter((c) => c.id === activeTab);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <button
          type="button"
          onClick={onBack}
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

      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Ideas &amp; Use Cases
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Click any card to start a conversation. It could become an on-demand
            task, a recurring workflow, or a subagent.
          </p>
        </div>
      </header>

      <div className="shrink-0 px-4 sm:px-6 pt-2 pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "rounded-lg h-8 px-3 text-sm font-medium transition-colors cursor-pointer",
              activeTab === "all"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            onClick={() => setActiveTab("all")}
          >
            All
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={cn(
                "rounded-lg h-8 px-3 text-sm font-medium transition-colors cursor-pointer",
                activeTab === category.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => setActiveTab(category.id)}
            >
              {category.title}
            </button>
          ))}
        </div>
      </div>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {visibleCategories.map((category) => (
            <section
              key={category.id}
              className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              <div>
                <h2 className="text-base font-semibold tracking-tight text-foreground">
                  {category.title}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {category.subtitle}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {category.cases.map((useCase) => (
                  <Card
                    key={useCase.title}
                    className="zero-card cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => onSelectPrompt(useCase.prompt)}
                  >
                    <CardContent className="p-4 group relative">
                      <IconArrowUpRight
                        size={14}
                        stroke={2}
                        className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
                      />
                      <p className="text-sm font-medium text-foreground pr-5">
                        {useCase.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                        {useCase.description}
                      </p>
                      {useCase.connectors && useCase.connectors.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-2.5">
                          {useCase.connectors.map((type) => (
                            <ConnectorIcon key={type} type={type} size={14} />
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
