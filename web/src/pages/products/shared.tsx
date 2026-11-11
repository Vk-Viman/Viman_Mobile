/**
 * Small helpers shared by the Products screens (products, categories and suppliers tabs).
 * Cross-screen helpers live elsewhere: lib/constants.ts (BOOK_LABEL, PAGE_SIZE...), hooks/useDebounced.ts.
 */

/** Choices of the "Status" filter on catalog lists. */
export type StatusFilter = 'active' | 'inactive' | 'all';

/**
 * Converts the Status drop-down value into the API's `active` filter:
 * 'all' -> undefined (no filter, so the parameter is omitted), 'active' -> true, 'inactive' -> false.
 */
export function statusToActive(status: StatusFilter): boolean | undefined {
  return status === 'all' ? undefined : status === 'active';
}

/** Drop-down options for the Status filter. Rendered by <StatusFilterOptions/> to keep the text in one place. */
export function StatusFilterOptions() {
  return (
    <>
      <option value="active">Active</option>
      <option value="inactive">Inactive</option>
      <option value="all">All</option>
    </>
  );
}
