import type { getCategories } from "./zero-ideation-data.ts";

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

function resolveUseCaseCopy(
  id: string,
  catalogCopy: IdeationCatalogCopy,
): IdeationUseCaseCopy {
  for (const categoryCopy of Object.values(catalogCopy)) {
    const copy = categoryCopy.cases[id];
    if (copy) {
      return copy;
    }
  }
  throw new Error(`Missing ideation use case copy: ${id}`);
}

export function localizeIdeationUseCase<T extends { readonly id: string }>(
  useCase: T,
  catalogCopy: IdeationCatalogCopy,
): T & IdeationUseCaseCopy {
  const copy = resolveUseCaseCopy(useCase.id, catalogCopy);
  return {
    ...useCase,
    title: copy.title,
    description: copy.description,
  };
}

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
