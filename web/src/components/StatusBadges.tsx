/**
 * Ready-made badges for statuses that appear in many tables, so the same state always has the same colour and text.
 */
import { Badge } from './Badge';
import { BOOK_LABEL } from '../lib/constants';
import type { Book, PostedStatus } from '../types/api';

/** "Shop" (green) or "Telecom" (grey): which accounting book a record belongs to. */
export function BookBadge({ book }: { book: Book }) {
  return <Badge tone={book === 'shop' ? 'brand' : 'neutral'}>{BOOK_LABEL[book]}</Badge>;
}

/** "Posted" (green) for live records, "Void" (red) for cancelled ones. */
export function PostedStatusBadge({ status }: { status: PostedStatus }) {
  return <Badge tone={status === 'void' ? 'red' : 'brand'}>{status === 'void' ? 'Void' : 'Posted'}</Badge>;
}

/** "Active" (green) or "Inactive" (grey): whether a catalog record is still in use. */
export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'brand' : 'neutral'}>{active ? 'Active' : 'Inactive'}</Badge>;
}
