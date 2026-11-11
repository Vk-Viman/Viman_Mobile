/**
 * ComingSoon: placeholder screen for menu entries whose real screen is not built yet.
 * Routes for these are generated automatically in App.tsx from the NAV_ITEMS that have `built: false`.
 * No API calls.
 */
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import type { LucideIcon } from 'lucide-react';

/** @param phase the delivery phase shown to the owner; @param description one line about what the screen will do. */
export function ComingSoon({ title, icon: Icon, phase, description }: { title: string; icon: LucideIcon; phase: number; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="rounded-full bg-brand-50 p-4 text-brand-600"><Icon size={32} aria-hidden="true" /></span>
          <p className="text-lg font-semibold text-slate-800">Available in Phase {phase}</p>
          <p className="max-w-md text-sm text-slate-500">{description}</p>
        </div>
      </Card>
    </>
  );
}
