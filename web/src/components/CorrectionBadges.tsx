/**
 * History helpers of "Correct this entry": the Edit button and the correction badges.
 *
 * `useCorrectionBadges(entity, ids)` asks GET /corrections once for the records visible in a list and returns a function that draws,
 * for one record, "Corrected by #n" (a voided original) and/or "Corrects #n - reason" (a replacement; both when a corrected entry was
 * itself corrected later). The badges are decoration: while the lookup is loading or fails, nothing is drawn.
 */
import type { ReactNode } from 'react';
import { Button } from './Button';
import { useCorrectionLinks } from '../api/corrections';
import type { CorrectionEntity } from '../api/corrections';

/** Row action "Edit" (its full name is "Correct this entry"). */
export function CorrectButton({ noun, id, onClick }: { noun: string; id: number; onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} title="Correct this entry" aria-label={`Correct this entry: ${noun} #${id}`}>Edit</Button>
  );
}

/** Hook: returns `badgesFor(id)` for the records of one visible list. */
export function useCorrectionBadges(entity: CorrectionEntity, ids: number[]): (id: number) => ReactNode {
  const links = useCorrectionLinks(entity, ids).data?.items ?? [];
  return (id) => {
    const by = links.find((l) => l.originalId === id);
    const of = links.find((l) => l.replacementId === id);
    if (!by && !of) return null;
    return (
      <span className="mt-1 flex flex-col items-start gap-1">
        {by && <span className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Corrected by #{by.replacementId}</span>}
        {of && (
          <span className="inline-block max-w-[16rem] rounded-2xl bg-brand-100 px-2.5 py-0.5 text-xs font-medium text-brand-800">
            Corrects #{of.originalId} - {of.reason}
          </span>
        )}
      </span>
    );
  };
}
