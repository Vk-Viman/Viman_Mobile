/**
 * Small constants shared by many screens. Giving them names (instead of repeating the numbers/strings) means a
 * change such as "show 25 rows per page" is made in exactly one place.
 */
import type { Book } from '../types/api';

/** Rows per page on every paged list (products, purchases, stock movements, losses...). Sent as `limit`. */
export const PAGE_SIZE = 50;

/**
 * How long (ms) to wait after the last keystroke before a search box starts a new request.
 * Without this, typing "samsung" would send 7 requests (one per letter); with it, one request when typing pauses.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/** Display names of the two accounting books. */
export const BOOK_LABEL: Record<Book, string> = { shop: 'Shop', telecom: 'Telecom' };

/** Tailwind classes for a standard checkbox. */
export const CHECKBOX_CLASS = 'h-4 w-4 rounded border-slate-300 text-brand-600';
