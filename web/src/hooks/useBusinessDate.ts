/**
 * useBusinessDate: the date field logic shared by every form that records a dated transaction
 * (new purchase, purchase return, stocktake, stock loss, personal use).
 */
import { useState } from 'react';
import { useHealth } from '../api/health';

/**
 * Provides the date to show/send and the latest date a picker should allow.
 *
 * - `today`: the server's business date (Asia/Colombo) from GET /health; '' until it has loaded. It is used as
 *   the date picker's `max`, because no transaction may be dated in the future (rule R-FD). That is only a
 *   convenience: the server rejects future dates itself (FUTURE_DATE_NOT_ALLOWED) and is the authority.
 *   The date comes from the server, not the PC clock, so a wrong PC clock cannot mislead the owner.
 * - `date`: what the form should display and submit: the owner's pick, or today when nothing was picked.
 *   Backdating (an earlier date) is allowed; it is audited by the server.
 * - `picked`: the raw pick ('' when the owner has not touched the field), for "only complain once edited" checks.
 * - `setDate`: change the pick.
 */
export function useBusinessDate() {
  const health = useHealth();
  const today = health.data?.today ?? '';
  const [picked, setPicked] = useState('');
  return { today, date: picked || today, picked, setDate: setPicked };
}
