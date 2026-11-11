/**
 * useClientRef: a random id created once when a "create" dialog opens, sent with the request as `clientRef`.
 */
import { useState } from 'react';

/**
 * Returns a unique id that stays the same for the whole life of the component.
 *
 * WHY: if the network drops after the server saved a purchase but before the answer arrived, the owner will click
 * Save again. Because that second request carries the SAME clientRef, the server recognises it and returns the
 * already-saved record instead of posting a duplicate (idempotent create). A fresh id is generated only when the
 * dialog is opened again (dialogs are mounted only while open), which is a genuinely new entry.
 * The lazy initialiser `() => ...` makes React generate the id only on the first render.
 */
export function useClientRef(): string {
  const [ref] = useState(() => crypto.randomUUID());
  return ref;
}
