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
    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-background">
      <span className="text-xs text-muted-foreground whitespace-nowrap px-1">
        {displayIndex}/{totalCount}
      </span>
      <button
        onClick={onPrevious}
        disabled={totalCount === 0}
        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <IconChevronUp className="h-4 w-4" />
      </button>
      <button
        onClick={onNext}
        disabled={totalCount === 0}
        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded"
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <IconChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}
