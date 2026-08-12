export function categoryFilterJson(categoryId: number): string {
  return JSON.stringify([categoryId]);
}

/**
 * Match attempts tagged with a category, or legacy attempts with empty `categories`
 * where questions in the attempt belong to that category.
 */
export function attemptMatchesCategoryWhere(
  attemptAlias: string,
  categoryId: number,
  categoryFilterParam = 'categoryFilter',
  categoryIdParam = 'categoryId',
): string {
  return `(
    ${attemptAlias}.categories @> :${categoryFilterParam}::jsonb
    OR (
      COALESCE(jsonb_array_length(${attemptAlias}.categories), 0) = 0
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${attemptAlias}."questionIds") AS elem(qid)
        INNER JOIN questions q
          ON q.id = (elem.qid)::int
         AND q.lang = ${attemptAlias}.lang
        WHERE :${categoryIdParam} = ANY(q.categories)
      )
    )
  )`;
}

export function attemptMatchesCategorySql(
  attemptAlias: string,
  categoryFilterPlaceholder: string,
  categoryIdPlaceholder: string,
): string {
  return `(
    ${attemptAlias}.categories @> ${categoryFilterPlaceholder}::jsonb
    OR (
      COALESCE(jsonb_array_length(${attemptAlias}.categories), 0) = 0
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${attemptAlias}."questionIds") AS elem(qid)
        INNER JOIN questions q
          ON q.id = (elem.qid)::int
         AND q.lang = ${attemptAlias}.lang
        WHERE ${categoryIdPlaceholder} = ANY(q.categories)
      )
    )
  )`;
}

/**
 * Cheaper category match when `user_answers` is already joined — uses the answer's
 * questionId instead of unnesting the full attempt `questionIds` array.
 */
export function answerJoinedCategorySql(
  attemptAlias: string,
  answerAlias: string,
  categoryFilterPlaceholder: string,
  categoryIdPlaceholder: string,
): string {
  return `(
    ${attemptAlias}.categories @> ${categoryFilterPlaceholder}::jsonb
    OR (
      COALESCE(jsonb_array_length(${attemptAlias}.categories), 0) = 0
      AND EXISTS (
        SELECT 1
        FROM questions q
        WHERE q.id = ${answerAlias}."questionId"
          AND q.lang = ${attemptAlias}.lang
          AND ${categoryIdPlaceholder} = ANY(q.categories)
      )
    )
  )`;
}

export function answerJoinedCategoryWhere(
  attemptAlias: string,
  answerAlias: string,
  categoryFilterParam = 'categoryFilter',
  categoryIdParam = 'categoryId',
): string {
  return `(
    ${attemptAlias}.categories @> :${categoryFilterParam}::jsonb
    OR (
      COALESCE(jsonb_array_length(${attemptAlias}.categories), 0) = 0
      AND EXISTS (
        SELECT 1
        FROM questions q
        WHERE q.id = ${answerAlias}.questionId
          AND q.lang = ${attemptAlias}.lang
          AND :${categoryIdParam} = ANY(q.categories)
      )
    )
  )`;
}

export function attemptCategoryMatchParams(
  categoryId: number,
): { categoryFilter: string; categoryId: number } {
  return {
    categoryFilter: categoryFilterJson(categoryId),
    categoryId,
  };
}
