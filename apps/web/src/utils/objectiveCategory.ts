/**
 * Default problem-number category for the create-problem form.
 *
 * Objective problems are auto-numbered in Y (Y1001, Y1002, ...), every other
 * problem type keeps the historical P default. The backend performs the actual
 * allocation; this module only decides which option the form should select and
 * whether `categoryId` should be submitted at all.
 */

import type { ProblemType } from '../api/types';

/** Built-in category code for objective problems. */
export const OBJECTIVE_CATEGORY_CODE = 'Y';
/** Built-in category code for programming problems. */
export const PROGRAMMING_CATEGORY_CODE = 'P';

interface CategoryLike {
  id: number;
  code: string;
}

/** The category code a newly created problem should default to. */
export function defaultCategoryCodeForType(type: ProblemType | string): string {
  return type === 'objective' ? OBJECTIVE_CATEGORY_CODE : PROGRAMMING_CATEGORY_CODE;
}

/**
 * Category id to preselect after the problem type changes. Returns `undefined`
 * when the preferred category is not available (not loaded yet or missing), so
 * the caller leaves the field empty and the backend allocates the number
 * instead of silently submitting a different category such as P.
 */
export function resolveCategoryIdForType<T extends CategoryLike>(
  type: ProblemType | string,
  categories: readonly T[],
): number | undefined {
  const code = defaultCategoryCodeForType(type);
  return categories.find((category) => category.code === code)?.id;
}

/**
 * `categoryId` value for the create request. A manual display id already
 * determines the category (the backend parses its prefix), so it is omitted
 * then; otherwise the explicit selection is submitted, and an empty selection
 * is left to the backend (objective -> Y, programming -> P).
 */
export function categoryIdForCreatePayload(input: {
  type: ProblemType | string;
  categoryId?: number;
  displayId?: string | null;
}): number | undefined {
  if (typeof input.displayId === 'string' && input.displayId.trim().length > 0) {
    return undefined;
  }
  return input.categoryId;
}
