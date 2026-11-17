/**
 * CashCorrections: thin adapters for transfers, capital entries and cash drawings (shared CorrectionDialog).
 * Each replacement body is the normal create body of its type (POST /cash-transfers, /capital, /drawings with kind "cash"),
 * pre-filled from the original, reusing the book/fund fields of the Drawings screens.
 */
import { useState } from 'react';
import { CorrectionDialog } from '../../components/CorrectionDialog';
import type { DescribeLine } from '../../components/CorrectionDialog';
import { Money } from '../../components/Money';
import { MoneyInput } from '../../components/MoneyInput';
import { SegmentSelect } from '../../components/SegmentSelect';
import { TextField } from '../../components/TextField';
import { MAX_NOTE, parseMoney } from '../../lib/amounts';
import { centsToRupees } from '../../lib/units';
import { isTelecomSegment } from '../../lib/segments';
import type { StoredSegment, TelecomSegment } from '../../types/segments';

/** 13D: the dialog starts on the original segment (legacy and none start empty, so a real segment must be chosen). */
const startSegment = (s: StoredSegment | null | undefined): TelecomSegment | '' => (isTelecomSegment(s) ? s : '');
const segErr = (show: boolean, book: CashBook, seg: string): string | undefined => (show && book === 'telecom' && seg === '' ? 'Choose the Telecom segment.' : undefined);
import type { CapitalEntry, CashBook, IceFund } from '../../types/cashbooks';
import type { OwnerDrawing, Transfer } from '../../types/transfers';
import { CASHBOOKS } from '../cashbooks/shared';
import { BookFundFields, bookFundLabel, fundFor } from '../drawings/BookFundFields';

const AMOUNT_ERR = 'Enter an amount above zero, such as 2500 or 2500.50.';

/** Correct a cash transfer between books. */
export function TransferCorrection({ original, onClose }: { original: Transfer; onClose: () => void }) {
  const [fromBook, setFromBook] = useState<CashBook>(original.fromBook);
  const [toBook, setToBook] = useState<CashBook>(original.toBook);
  const [fromFund, setFromFund] = useState<IceFund>(original.fromFund ?? 'profit');
  const [toFund, setToFund] = useState<IceFund>(original.toFund ?? 'cost');
  const [fromSegment, setFromSegment] = useState<TelecomSegment | ''>(startSegment(original.fromSegment));
  const [toSegment, setToSegment] = useState<TelecomSegment | ''>(startSegment(original.toSegment));
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [note, setNote] = useState(original.note ?? '');
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);

  const chooseFrom = (b: CashBook) => { setFromBook(b); if (b === toBook && b !== 'telecom') setToBook(CASHBOOKS.find((x) => x !== b) ?? 'telecom'); };
  const chooseTo = (b: CashBook) => { setToBook(b); if (b === fromBook && b !== 'telecom') setFromBook(CASHBOOKS.find((x) => x !== b) ?? 'shop'); };
  const describe = (t: Transfer): DescribeLine[] => [
    ['Date', t.businessDate], ['From', bookFundLabel(t.fromBook, t.fromFund, t.fromSegment)], ['To', bookFundLabel(t.toBook, t.toFund, t.toSegment)],
    ['Amount', <Money key="a" cents={t.amountCents} />], ['Note', t.note || '—'],
  ];

  return (
    <CorrectionDialog<Transfer> entity="cash_transfers" noun="transfer" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        const sameSeg = fromBook === 'telecom' && toBook === 'telecom' && fromSegment === toSegment;
        if (cents === null || (fromBook === toBook && fromBook !== 'telecom') || sameSeg || segErr(true, fromBook, fromSegment) || segErr(true, toBook, toSegment) || note.length > MAX_NOTE) { setShow(true); return null; }
        return {
          businessDate, fromBook, toBook, ...(fromBook === 'telecom' && fromSegment ? { fromSegment } : {}), ...(toBook === 'telecom' && toSegment ? { toSegment } : {}),
          ...(fromBook === 'icecream' ? { fromFund } : {}), ...(toBook === 'icecream' ? { toFund } : {}),
          amountCents: cents, note: note.trim() || undefined, clientRef,
        };
      }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-4"><BookFundFields bookLabel="From book" fundLabel="From fund" book={fromBook} fund={fromFund} onBook={chooseFrom} onFund={setFromFund} />
          {fromBook === 'telecom' && <SegmentSelect label="From segment" value={fromSegment} onChange={setFromSegment} error={segErr(show, fromBook, fromSegment)} />}</div>
        <div className="space-y-4"><BookFundFields bookLabel="To book" fundLabel="To fund" book={toBook} fund={toFund} onBook={chooseTo} onFund={setToFund} disabledBook={fromBook === 'telecom' ? undefined : fromBook} />
          {toBook === 'telecom' && <SegmentSelect label="To segment" value={toSegment} onChange={setToSegment} error={segErr(show, toBook, toSegment) ?? (show && fromBook === 'telecom' && fromSegment === toSegment ? 'Choose a different segment from the source.' : undefined)} />}</div>
      </div>
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? AMOUNT_ERR : undefined} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}

/** Correct a capital entry (kind capital only; opening balances are not correctable). */
export function CapitalCorrection({ original, onClose }: { original: CapitalEntry; onClose: () => void }) {
  const [book, setBook] = useState<CashBook>(original.book);
  const [fund, setFund] = useState<IceFund>(original.fund ?? 'cost');
  const [segment, setSegment] = useState<TelecomSegment | ''>(startSegment(original.segment));
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [note, setNote] = useState(original.note ?? '');
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);
  const describe = (e: CapitalEntry): DescribeLine[] => [
    ['Date', e.businessDate], ['Put into', bookFundLabel(e.book, e.fund, e.segment)], ['Amount', <Money key="a" cents={e.amountCents} />], ['Note', e.note || '—'],
  ];
  return (
    <CorrectionDialog<CapitalEntry> entity="capital_entries" noun="capital entry" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (cents === null || segErr(true, book, segment) || note.length > MAX_NOTE) { setShow(true); return null; }
        return { businessDate, book, ...(book === 'telecom' && segment ? { segment } : {}), ...fundFor(book, fund), amountCents: cents, note: note.trim() || undefined, clientRef };
      }}>
      <BookFundFields bookLabel="Put into" fundLabel="Into which fund?" book={book} fund={fund} onBook={setBook} onFund={setFund} />
      {book === 'telecom' && <SegmentSelect value={segment} onChange={setSegment} error={segErr(show, book, segment)} />}
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? AMOUNT_ERR : undefined} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}

/** Correct a cash drawing (kind cash only; goods drawings are not correctable). */
export function DrawingCorrection({ original, onClose }: { original: OwnerDrawing; onClose: () => void }) {
  const [book, setBook] = useState<CashBook>(original.book);
  const [fund, setFund] = useState<IceFund>(original.fund ?? 'profit');
  const [segment, setSegment] = useState<TelecomSegment | ''>(startSegment(original.segment));
  const [amount, setAmount] = useState(centsToRupees(original.amountCents));
  const [note, setNote] = useState(original.note ?? '');
  const [show, setShow] = useState(false);
  const cents = parseMoney(amount);
  const describe = (d: OwnerDrawing): DescribeLine[] => [
    ['Date', d.businessDate], ['Taken from', bookFundLabel(d.book, d.fund, d.segment)], ['Amount', <Money key="a" cents={d.amountCents} />], ['Note', d.note || '—'],
  ];
  return (
    <CorrectionDialog<OwnerDrawing> entity="owner_drawings" noun="cash drawing" original={original} originalId={original.id} originalDate={original.businessDate}
      describe={describe} onClose={onClose}
      build={({ businessDate, clientRef }) => {
        if (cents === null || segErr(true, book, segment) || note.length > MAX_NOTE) { setShow(true); return null; }
        return { kind: 'cash', businessDate, book, ...(book === 'telecom' && segment ? { segment } : {}), ...fundFor(book, fund), amountCents: cents, note: note.trim() || undefined, clientRef };
      }}>
      <BookFundFields bookLabel="Taken from" book={book} fund={fund} onBook={setBook} onFund={setFund} />
      {book === 'telecom' && <SegmentSelect value={segment} onChange={setSegment} error={segErr(show, book, segment)} />}
      <MoneyInput label="Amount (Rs.)" value={amount} onChange={setAmount} error={show && cents === null ? AMOUNT_ERR : undefined} />
      <TextField label="Note (optional)" value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
    </CorrectionDialog>
  );
}
