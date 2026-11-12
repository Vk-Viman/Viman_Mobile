/**
 * The four dashboard charts (Recharts), each wrapped in a ChartCard so it has an accessible table alternative:
 *  1. last 30 days: sales (line) vs profit (bars; a loss bar is red and points below the zero line),
 *  2. last 12 months: profit by segment, stacked bars (segment colours from segments.ts),
 *  3. top products this month by gross profit (horizontal bars, losses red),
 *  4. cash per book (bars; Ice Cream funds are listed in the table alternative separately from profit).
 * The charts only draw figures the server sent (cents); tooltips and the tables show them as rupees.
 */
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatLKR } from '../../lib/format';
import type { Dashboard } from '../../types/dashboard';
import { ChartCard, LegendItem } from './ChartCard';
import { COMBINED_COLOR, LOSS_COLOR, SALES_COLOR, SEGMENTS, SEGMENT_COLOR, SEGMENT_LABEL, compactRupees } from './segments';

const money = (v: unknown): string => formatLKR(Number(v));
const axis = { fontSize: 11, fill: '#475569' } as const;

/** Sales vs profit for the last 30 days. */
export function DailyChart({ rows }: { rows: Dashboard['series']['daily'] }) {
  const empty = rows.every((r) => r.salesCents === 0 && r.profitCents === 0);
  const totalProfit = rows.reduce((a, r) => a + r.profitCents, 0);
  return (
    <ChartCard title="Sales and profit, last 30 days" isEmpty={empty} emptyText="No sales or profit in the last 30 days"
      summary={`Daily sales and profit for the last ${rows.length} days. Total profit ${formatLKR(totalProfit)}. Use Show as table for every day.`}
      columns={[{ key: 'date', label: 'Date' }, { key: 'sales', label: 'Sales', money: true }, { key: 'profit', label: 'Profit', money: true }]}
      rows={rows.map((r) => ({ date: r.date, sales: r.salesCents, profit: r.profitCents }))}
      legend={<><LegendItem color={SALES_COLOR} label="Sales (line)" /><LegendItem color={COMBINED_COLOR} label="Profit (bars)" /><LegendItem color={LOSS_COLOR} label="Loss (red bars)" /></>}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={axis} tickFormatter={compactRupees} width={48} />
          <Tooltip formatter={(v, name) => [money(v), name === 'salesCents' ? 'Sales' : 'Profit']} labelFormatter={(l) => String(l)} />
          <ReferenceLine y={0} stroke="#64748b" />
          <Bar dataKey="profitCents" name="profitCents" isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.date} fill={r.profitCents < 0 ? LOSS_COLOR : COMBINED_COLOR} />)}
          </Bar>
          <Line dataKey="salesCents" name="salesCents" stroke="#475569" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Profit by segment for the last 12 months, stacked. */
export function MonthlyChart({ rows }: { rows: Dashboard['series']['monthly'] }) {
  const empty = rows.every((r) => r.combinedCents === 0 && r.shopCents === 0 && r.telecomCents === 0 && r.icecreamCents === 0);
  const keys = { shop: 'shopCents', telecom: 'telecomCents', icecream: 'icecreamCents' } as const;
  return (
    <ChartCard title="Profit by segment, last 12 months" isEmpty={empty} emptyText="No profit or loss in the last 12 months"
      summary={`Monthly profit for Shop, Telecom and Ice Cream over ${rows.length} months, stacked. Losses go below the zero line. Use Show as table for the numbers.`}
      columns={[{ key: 'month', label: 'Month' }, { key: 'shop', label: 'Shop', money: true }, { key: 'telecom', label: 'Telecom', money: true },
        { key: 'icecream', label: 'Ice Cream', money: true }, { key: 'combined', label: 'Combined', money: true }]}
      rows={rows.map((r) => ({ month: r.month, shop: r.shopCents, telecom: r.telecomCents, icecream: r.icecreamCents, combined: r.combinedCents }))}
      legend={SEGMENTS.map((s) => <LegendItem key={s} color={SEGMENT_COLOR[s]} label={SEGMENT_LABEL[s]} />)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="month" tick={axis} tickFormatter={(m: string) => m.slice(2)} />
          <YAxis tick={axis} tickFormatter={compactRupees} width={48} />
          <Tooltip formatter={(v, name) => [money(v), SEGMENT_LABEL[(Object.entries(keys).find(([, k]) => k === name)?.[0] ?? 'shop') as keyof typeof SEGMENT_LABEL]]} />
          <ReferenceLine y={0} stroke="#64748b" />
          {SEGMENTS.map((s) => <Bar key={s} dataKey={keys[s]} name={keys[s]} stackId="p" fill={SEGMENT_COLOR[s]} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Top products this month by gross profit. */
export function TopProductsChart({ rows }: { rows: Dashboard['series']['topProducts'] }) {
  return (
    <ChartCard title="Top products this month" isEmpty={rows.length === 0} emptyText="No product sales this month"
      summary={`Gross profit of the top ${rows.length} products this month. Use Show as table for revenue and profit.`}
      columns={[{ key: 'name', label: 'Product' }, { key: 'revenue', label: 'Revenue', money: true }, { key: 'profit', label: 'Gross profit', money: true }]}
      rows={rows.map((r) => ({ name: r.name, revenue: r.revenueCents, profit: r.grossProfitCents }))}
      legend={<><LegendItem color={COMBINED_COLOR} label="Gross profit" /><LegendItem color={LOSS_COLOR} label="Loss" /></>}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis type="number" tick={axis} tickFormatter={compactRupees} />
          <YAxis type="category" dataKey="name" tick={axis} width={96} />
          <Tooltip formatter={(v) => [money(v), 'Gross profit']} />
          <ReferenceLine x={0} stroke="#64748b" />
          <Bar dataKey="grossProfitCents" isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.name} fill={r.grossProfitCents < 0 ? LOSS_COLOR : COMBINED_COLOR} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Cash balance per book; the table alternative also lists the three Ice Cream funds on their own lines. */
export function CashChart({ cash }: { cash: Dashboard['cash'] }) {
  const data = cash.books.map((b) => ({ book: SEGMENT_LABEL[b.book], key: b.book, cents: b.balanceCents }));
  const empty = cash.books.every((b) => b.balanceCents === 0);
  const tableRows: Array<Record<string, string | number>> = data.map((d) => ({ book: d.book, cents: d.cents }));
  const ice = cash.books.find((b) => b.funds)?.funds;
  if (ice) {
    tableRows.push({ book: '  Ice Cream: Cost fund', cents: ice.cost }, { book: '  Ice Cream: Electricity fund', cents: ice.electricity }, { book: '  Ice Cream: Profit fund', cents: ice.profit });
  }
  return (
    <ChartCard title="Cash in each book" isEmpty={empty} emptyText="No cash recorded yet"
      summary={`Cash balance of each book: ${data.map((d) => `${d.book} ${formatLKR(d.cents)}`).join(', ')}.`}
      columns={[{ key: 'book', label: 'Book / fund' }, { key: 'cents', label: 'Balance', money: true }]} rows={tableRows}
      legend={SEGMENTS.map((s) => <LegendItem key={s} color={SEGMENT_COLOR[s]} label={SEGMENT_LABEL[s]} />)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="book" tick={axis} />
          <YAxis tick={axis} tickFormatter={compactRupees} width={48} />
          <Tooltip formatter={(v) => [money(v), 'Balance']} />
          <ReferenceLine y={0} stroke="#64748b" />
          <Bar dataKey="cents" isAnimationActive={false}>
            {data.map((d) => <Cell key={d.key} fill={d.cents < 0 ? LOSS_COLOR : SEGMENT_COLOR[d.key]} />)}
          </Bar>
          <Legend content={() => null} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
