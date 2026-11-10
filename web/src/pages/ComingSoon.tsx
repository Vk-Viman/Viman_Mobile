import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import type { LucideIcon } from 'lucide-react';

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
