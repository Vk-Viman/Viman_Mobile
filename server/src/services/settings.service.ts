import type { AppContext } from '../app.ts';
import { AppError } from '../lib/errors.ts';
import { getAllSettings, upsertSetting } from '../repositories/settings.repo.ts';
import { logAudit } from './audit.service.ts';

export interface ShopSettings { name: string; address: string; phone: string; email: string }
export interface RateSettings { reloadCommissionBp: number; ezcashCommissionBp: number }
export interface PrintDefault { code: string; name: string; priceCents: number; costCents: number }
export interface Settings {
  shop: ShopSettings;
  rates: RateSettings;
  printDefaults: PrintDefault[];
  updatedAt: string | null;
}
export interface SettingsPatch {
  shop?: ShopSettings;
  rates?: RateSettings;
  printDefaults?: PrintDefault[];
}

interface Sections { shop: ShopSettings; rates: RateSettings; printDefaults: PrintDefault[] }
type SectionKey = keyof Sections;
const SECTIONS: readonly SectionKey[] = ['shop', 'rates', 'printDefaults'];

export const DEFAULTS: Sections = {
  shop: {
    name: 'Viman Mobile',
    address: '162 Padiliyathuduwa Rd, Hunupitiya, Wattala',
    phone: '+94 71 900 4044',
    email: 'viman.mobile.shop@gmail.com',
  },
  rates: { reloadCommissionBp: 600, ezcashCommissionBp: 80 },
  printDefaults: [
    { code: 'BW_1S', name: 'B/W print – one side', priceCents: 1500, costCents: 650 },
    { code: 'BW_2S', name: 'B/W print – double side', priceCents: 2500, costCents: 900 },
    { code: 'CLR_1S', name: 'Colour print – one side', priceCents: 2000, costCents: 650 },
    { code: 'CLR_2S', name: 'Colour print – double side', priceCents: 3000, costCents: 900 },
    { code: 'PC_BW_1S', name: 'Photocopy B/W – one side', priceCents: 1000, costCents: 650 },
    { code: 'PC_BW_2S', name: 'Photocopy B/W – double side', priceCents: 1500, costCents: 900 },
    { code: 'CUSTOM', name: 'Custom image print', priceCents: 4000, costCents: 650 },
  ],
};

function effectiveSections(ctx: AppContext): { values: Sections; updatedAt: string | null } {
  const rows = getAllSettings(ctx.database.conn);
  const values: Sections = structuredClone(DEFAULTS);
  let updatedAt: string | null = null;
  for (const row of rows) {
    if (updatedAt === null || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
    if (!(SECTIONS as readonly string[]).includes(row.key)) continue;
    try {
      const parsed: unknown = JSON.parse(row.valueJson);
      if (row.key === 'shop') values.shop = parsed as ShopSettings;
      else if (row.key === 'rates') values.rates = parsed as RateSettings;
      else values.printDefaults = parsed as PrintDefault[];
    } catch {
      // Corrupt stored value: fall back to the default for this section.
    }
  }
  return { values, updatedAt };
}

export function getSettings(ctx: AppContext): Settings {
  const { values, updatedAt } = effectiveSections(ctx);
  return { shop: values.shop, rates: values.rates, printDefaults: values.printDefaults, updatedAt };
}

function normalizeAndValidate(patch: SettingsPatch): SettingsPatch {
  const fields: Record<string, string> = {};
  const out: SettingsPatch = {};

  if (patch.shop !== undefined) {
    const shop: ShopSettings = {
      name: (patch.shop.name ?? '').trim(),
      address: (patch.shop.address ?? '').trim(),
      phone: (patch.shop.phone ?? '').trim(),
      email: (patch.shop.email ?? '').trim(),
    };
    if (shop.name === '') fields['shop.name'] = 'Shop name is required.';
    if (shop.email !== '' && !shop.email.includes('@')) fields['shop.email'] = 'Enter a valid email address.';
    out.shop = shop;
  }

  if (patch.rates !== undefined) {
    out.rates = {
      reloadCommissionBp: patch.rates.reloadCommissionBp,
      ezcashCommissionBp: patch.rates.ezcashCommissionBp,
    };
  }

  if (patch.printDefaults !== undefined) {
    const seen = new Set<string>();
    out.printDefaults = patch.printDefaults.map((p, i) => {
      const item: PrintDefault = {
        code: p.code,
        name: p.name.trim(),
        priceCents: p.priceCents,
        costCents: p.costCents,
      };
      if (item.name === '') fields[`printDefaults.${i}.name`] = 'Name is required.';
      if (seen.has(item.code)) fields[`printDefaults.${i}.code`] = 'This code is used more than once.';
      seen.add(item.code);
      return item;
    });
  }

  if (Object.keys(fields).length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', fields);
  }
  return out;
}

export function updateSettings(ctx: AppContext, patch: SettingsPatch): Settings {
  const clean = normalizeAndValidate(patch);
  ctx.database.tx((conn) => {
    const { values } = effectiveSections(ctx);
    for (const section of SECTIONS) {
      const next = clean[section];
      if (next === undefined) continue;
      const before = values[section];
      if (JSON.stringify(before) === JSON.stringify(next)) continue;
      upsertSetting(conn, section, JSON.stringify(next));
      logAudit(conn, 'settings', section, 'update', before, next);
    }
  });
  return getSettings(ctx);
}
