import type { getCategories } from "./ideation-data.ts";

interface IdeationUseCaseCopy {
  readonly title: string;
  readonly description: string;
}

interface IdeationCategoryCopy {
  readonly title: string;
  readonly cases: Readonly<Record<string, IdeationUseCaseCopy>>;
}

export type IdeationCatalogCopy = Readonly<
  Record<string, IdeationCategoryCopy>
>;

export function localizeIdeationCategories(
  categories: ReturnType<typeof getCategories>,
  catalogCopy: IdeationCatalogCopy,
) {
  return categories.map((category) => {
    const categoryCopy = catalogCopy[category.id];
    if (!categoryCopy) {
      throw new Error(`Missing ideation category copy: ${category.id}`);
    }
    return {
      ...category,
      title: categoryCopy.title,
      cases: category.cases.map((useCase) => {
        const copy = categoryCopy.cases[useCase.id];
        if (!copy) {
          throw new Error(`Missing ideation use case copy: ${useCase.id}`);
        }
        return {
          ...useCase,
          title: copy.title,
          description: copy.description,
        };
      }),
    };
  });
}
