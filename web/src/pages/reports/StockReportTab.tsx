/**
 * Reports > Stock tab: Stock value (inventory valuation with book/category grouping and an "as of" date), Low stock,
 * Movements (filters and paging), Losses and Product profitability. Which section is open is kept in the URL.
 * Every figure comes from the server (Phase 11 operational reports); this file only chooses the section.
 */
import { LossesPanel, LowStockPanel, MovementsPanel, ProfitPanel, ValuationPanel } from './opsStockPanels';
import { SectionPills, useOpsSection } from './opsParts';

const SECTIONS = ['value', 'low', 'movements', 'losses', 'profit'] as const;
type Section = typeof SECTIONS[number];
const ITEMS: Array<{ key: Section; label: string }> = [
  { key: 'value', label: 'Stock value' }, { key: 'low', label: 'Low stock' }, { key: 'movements', label: 'Movements' },
  { key: 'losses', label: 'Losses' }, { key: 'profit', label: 'Product profit' },
];

/** The Stock reports tab. */
export function StockReportTab() {
  const [section, setSection] = useOpsSection<Section>(SECTIONS);
  return (
    <div>
      <SectionPills items={ITEMS} value={section} onChange={setSection} />
      {section === 'value' && <ValuationPanel />}
      {section === 'low' && <LowStockPanel />}
      {section === 'movements' && <MovementsPanel />}
      {section === 'losses' && <LossesPanel />}
      {section === 'profit' && <ProfitPanel />}
    </div>
  );
}
