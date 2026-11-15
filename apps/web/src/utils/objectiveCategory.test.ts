import { describe, expect, it } from 'vitest';
import {
  categoryIdForCreatePayload,
  defaultCategoryCodeForType,
  resolveCategoryIdForType,
} from './objectiveCategory';

const categories = [
  { id: 1, code: 'P', name: 'P' },
  { id: 2, code: 'Y', name: '客观题题库' },
  { id: 3, code: 'C', name: 'C 题库' },
];

describe('objective category defaults', () => {
  it('defaults objective problems to Y and every other type to P', () => {
    expect(defaultCategoryCodeForType('objective')).toBe('Y');
    for (const type of ['standard', 'file-io', 'interactive', 'output-only']) {
      expect(defaultCategoryCodeForType(type)).toBe('P');
    }
  });

  it('selects Y for objective problems when the category exists', () => {
    expect(resolveCategoryIdForType('objective', categories)).toBe(2);
    expect(resolveCategoryIdForType('standard', categories)).toBe(1);
    expect(resolveCategoryIdForType('file-io', categories)).toBe(1);
  });

  it('returns undefined instead of silently falling back to P when the preferred category is missing', () => {
    // A database that has not loaded/created Y yet: the form must leave the
    // field empty so the backend auto-assigns Y rather than submitting P.
    expect(resolveCategoryIdForType('objective', [{ id: 1, code: 'P' }])).toBeUndefined();
    expect(resolveCategoryIdForType('objective', [])).toBeUndefined();
    // Programming types keep the same no-silent-fallback rule for a missing P.
    expect(resolveCategoryIdForType('standard', [{ id: 2, code: 'Y' }])).toBeUndefined();
  });

  it('lets a manual display id decide the category and keeps an explicit selection otherwise', () => {
    expect(
      categoryIdForCreatePayload({ type: 'objective', categoryId: 2, displayId: 'P2000' }),
    ).toBeUndefined();
    expect(
      categoryIdForCreatePayload({ type: 'standard', categoryId: 1, displayId: ' Y1001 ' }),
    ).toBeUndefined();
    expect(categoryIdForCreatePayload({ type: 'objective', categoryId: 2 })).toBe(2);
    expect(categoryIdForCreatePayload({ type: 'objective' })).toBeUndefined();
    expect(categoryIdForCreatePayload({ type: 'standard', categoryId: 1 })).toBe(1);
  });
});
