/**
 * useDebounced: delays a fast-changing value (like the text in a search box) until it has stopped changing.
 * Used by every search box so the server is queried once per pause in typing instead of once per keystroke.
 */
import { useEffect, useState } from 'react';
import { SEARCH_DEBOUNCE_MS } from '../lib/constants';

/**
 * Returns `value` as it was `ms` milliseconds ago, once it has stayed unchanged for that long.
 * The text box itself should keep showing the live value; only the value that goes into the API query is debounced.
 * Each change restarts the timer (the cleanup cancels the previous one), so only the final value gets through.
 */
export function useDebounced<T>(value: T, ms = SEARCH_DEBOUNCE_MS): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
