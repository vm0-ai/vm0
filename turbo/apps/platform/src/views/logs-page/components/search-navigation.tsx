import { IconChevronUp, IconChevronDown } from "@tabler/icons-react";

interface SearchNavigationProps {
  currentIndex: number;
  totalCount: number;
  onNext: () => void;
  onPrevious: () => void;
  hasSearchTerm: boolean;
}

export function SearchNavigation({
  currentIndex,
  totalCount,
  onNext,
  onPrevious,
  hasSearchTerm,
}: SearchNavigationProps) {
  if (!hasSearchTerm) {
    return null;
  }

  const displayIndex = totalCount > 0 ? currentIndex + 1 : 0;

  return (
    <div className="flex items-center h-full border-l border-border">
      <span className="text-xs text-muted-foreground whitespace-nowrap px-2">
        {totalCount > 0 ? (
          <>
            {displayIndex}/{totalCount}
          </>
        ) : (
          "0/0"
        )}
      </span>
      <div className="flex items-center border-l border-border">
        <button
          onClick={onPrevious}
          disabled={totalCount === 0}
          className="h-9 px-1 text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          <IconChevronUp className="h-4 w-4" />
        </button>
        <button
          onClick={onNext}
          disabled={totalCount === 0}
          className="h-9 px-1 text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Next match (Enter)"
          aria-label="Next match"
        >
          <IconChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
