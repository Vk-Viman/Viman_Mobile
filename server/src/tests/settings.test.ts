// Settings API (GET/PUT /settings) - API level (Fastify inject, real temp database).
// Protects: the shop's default settings (name, commission rates in basis points - reload 600 bp = 6%, EZCash 80 bp = 0.8%,
// section 5 - and the printing price/cost list, R12), strict validation (C11: every rate 0..10000 bp, whole cents, no
// coercion of strings/null), and the audit rule that every settings change writes before/after JSON (section 12) while
// an unchanged save writes nothing.
// Organised as: defaults, update + audit behaviour, boundary values, a big table of invalid inputs, persistence.

import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TestEnv } from './helpers/tmp.ts';

const env = new TestEnv();
afterEach(() => env.cleanup());

// Factory print/photocopy price list in cents, e.g. B/W one side: price Rs 15.00, standard cost Rs 6.50
// (R12: revenue - standard cost = gross profit per page).
const DEFAULT_PRINT = [
  { code: 'BW_1S', name: 'B/W print – one side', priceCents: 1500, costCents: 650 },
  { code: 'BW_2S', name: 'B/W print – double side', priceCents: 2500, costCents: 900 },
  { code: 'CLR_1S', name: 'Colour print – one side', priceCents: 2000, costCents: 650 },
  { code: 'CLR_2S', name: 'Colour print – double side', priceCents: 3000, costCents: 900 },
  { code: 'PC_BW_1S', name: 'Photocopy B/W – one side', priceCents: 1000, costCents: 650 },
  { code: 'PC_BW_2S', name: 'Photocopy B/W – double side', priceCents: 1500, costCents: 900 },
  { code: 'CUSTOM', name: 'Custom image print', priceCents: 4000, costCents: 650 },
];

const put = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: 'PUT', url: '/api/v1/settings', payload: body as object });
const audit = async (app: FastifyInstance, q = '') =>
  (await app.inject({ method: 'GET', url: `/api/v1/audit-logs${q}` })).json();

const validShop = { name: 'Shop', address: 'a', phone: 'p', email: '' };
const validRates = { reloadCommissionBp: 600, ezcashCommissionBp: 80 };
const validPd = { code: 'A1', name: 'n', priceCents: 1, costCents: 1 };

// A new installation must show the agreed defaults.
describe('GET /settings', () => {
  it('returns the exact defaults', async () => {
    const { app } = await env.build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      shop: {
        name: 'Viman Mobile',
        address: '162 Padiliyathuduwa Rd, Hunupitiya, Wattala',
        phone: '+94 71 900 4044',
        email: 'viman.mobile.shop@gmail.com',
      },
      rates: { reloadCommissionBp: 600, ezcashCommissionBp: 80 },
      printDefaults: DEFAULT_PRINT,
      updatedAt: null,
    });
    expect(res.json().printDefaults).toHaveLength(7);
  });
});

// Saving settings: partial updates, audit rows, boundaries and validation.
describe('PUT /settings', () => {
  it('shop: trims name, leaves other sections, sets updatedAt, writes ONE audit row', async () => {
    const { app } = await env.build();
    const res = await put(app, { shop: { name: '  New Name  ', address: 'Addr', phone: '123', email: 'a@b.c' } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.shop).toEqual({ name: 'New Name', address: 'Addr', phone: '123', email: 'a@b.c' });
    expect(b.rates).toEqual({ reloadCommissionBp: 600, ezcashCommissionBp: 80 });
    expect(b.printDefaults).toEqual(DEFAULT_PRINT);
    expect(typeof b.updatedAt).toBe('string');
    expect(new Date(b.updatedAt).getTime()).not.toBeNaN();

    const a = await audit(app);
    expect(a.items).toHaveLength(1);
    expect(a.items[0]).toMatchObject({
      entity: 'settings', entityId: 'shop', action: 'update',
      before: { name: 'Viman Mobile', address: '162 Padiliyathuduwa Rd, Hunupitiya, Wattala', phone: '+94 71 900 4044', email: 'viman.mobile.shop@gmail.com' },
      after: { name: 'New Name', address: 'Addr', phone: '123', email: 'a@b.c' },
    });
    const get = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json();
    expect(get).toEqual(b);
  });

  // Re-saving the same values is not a change, so the audit log is not filled with noise.
  it('identical values do not create a new audit row', async () => {
    const { app } = await env.build();
    const body = { shop: { name: 'X', address: '', phone: '', email: '' } };
    await put(app, body);
    expect((await audit(app)).items).toHaveLength(1);
    const res = await put(app, body);
    expect(res.statusCode).toBe(200);
    expect((await audit(app)).items).toHaveLength(1);
  });

  it('putting the defaults unchanged logs nothing', async () => {
    const { app } = await env.build();
    const res = await put(app, { rates: { reloadCommissionBp: 600, ezcashCommissionBp: 80 }, printDefaults: DEFAULT_PRINT });
    expect(res.statusCode).toBe(200);
    expect((await audit(app)).items).toHaveLength(0);
  });

  // One audit row per changed settings section, so each change can be traced separately.
  it('rates + printDefaults produce two audit rows', async () => {
    const { app } = await env.build();
    const res = await put(app, {
      rates: { reloadCommissionBp: 700, ezcashCommissionBp: 90 },
      printDefaults: [{ code: 'ONE', name: 'One', priceCents: 100, costCents: 50 }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rates).toEqual({ reloadCommissionBp: 700, ezcashCommissionBp: 90 });
    expect(res.json().printDefaults).toEqual([{ code: 'ONE', name: 'One', priceCents: 100, costCents: 50 }]);
    const a = await audit(app);
    expect(a.items).toHaveLength(2);
    expect(a.items.map((i: { entityId: string }) => i.entityId).sort()).toEqual(['printDefaults', 'rates']);
    const rates = a.items.find((i: { entityId: string }) => i.entityId === 'rates');
    expect(rates.before).toEqual({ reloadCommissionBp: 600, ezcashCommissionBp: 80 });
    expect(rates.after).toEqual({ reloadCommissionBp: 700, ezcashCommissionBp: 90 });
  });

  // Maximum lengths, rate 0 and 10000 bp (100%), 30 print items and Rs 1,000,000.00 prices are all valid (C11: 0 <= rateBp <= 10000).
  it('accepts boundary values', async () => {
    const { app } = await env.build();
    const res = await put(app, {
      shop: { name: 'n'.repeat(100), address: 'a'.repeat(200), phone: 'p'.repeat(30), email: 'e'.repeat(98) + '@x' },
      rates: { reloadCommissionBp: 0, ezcashCommissionBp: 10000 },
      printDefaults: Array.from({ length: 30 }, (_, i) => ({ code: `C${i}`, name: 'n'.repeat(60), priceCents: 100000000, costCents: 0 })),
    });
    expect(res.statusCode).toBe(200);
  });

  // Table of invalid requests: [description, body, fields the error must name]. Each must give 400 VALIDATION_ERROR
  // and leave the stored settings untouched. Rates may not be negative, above 10000 bp, fractional, null or text (no coercion).
  type Case = [string, unknown, string[]];
  const cases: Case[] = [
    ['empty body {}', {}, ['body']],
    ['unknown top-level field', { nope: 1 }, ['nope']],
    ['unknown top-level alongside valid', { shop: validShop, nope: 1 }, ['nope']],
    ['unknown nested field in shop', { shop: { ...validShop, extra: 1 } }, ['shop.extra']],
    ['unknown nested field in rates', { rates: { ...validRates, extra: 1 } }, ['rates.extra']],
    ['name empty', { shop: { ...validShop, name: '' } }, ['shop.name']],
    ['name whitespace', { shop: { ...validShop, name: '   ' } }, ['shop.name']],
    ['name > 100 chars', { shop: { ...validShop, name: 'x'.repeat(101) } }, ['shop.name']],
    ['name missing', { shop: { address: 'a' } }, ['shop.name']],
    ['address > 200', { shop: { ...validShop, address: 'x'.repeat(201) } }, ['shop.address']],
    ['phone > 30', { shop: { ...validShop, phone: 'x'.repeat(31) } }, ['shop.phone']],
    ['email without @', { shop: { ...validShop, email: 'nope' } }, ['shop.email']],
    ['email > 100', { shop: { ...validShop, email: 'x'.repeat(100) + '@a' } }, ['shop.email']],
    ['name is number', { shop: { ...validShop, name: 5 } }, ['shop.name']],
    ['rate > 10000', { rates: { reloadCommissionBp: 10001, ezcashCommissionBp: 80 } }, ['rates.reloadCommissionBp']],
    ['rate negative', { rates: { reloadCommissionBp: 600, ezcashCommissionBp: -1 } }, ['rates.ezcashCommissionBp']],
    ['rate missing', { rates: { reloadCommissionBp: 600 } }, ['rates.ezcashCommissionBp']],
    ['rate null (no coercion)', { rates: { reloadCommissionBp: null, ezcashCommissionBp: 80 } }, ['rates.reloadCommissionBp']],
    ['rate string "600" (no coercion)', { rates: { reloadCommissionBp: '600', ezcashCommissionBp: 80 } }, ['rates.reloadCommissionBp']],
    ['rate non-integer', { rates: { reloadCommissionBp: 6.5, ezcashCommissionBp: 80 } }, ['rates.reloadCommissionBp']],
    ['rate boolean', { rates: { reloadCommissionBp: true, ezcashCommissionBp: 80 } }, ['rates.reloadCommissionBp']],
    ['priceCents 1.5', { printDefaults: [{ ...validPd, priceCents: 1.5 }] }, ['printDefaults.0.priceCents']],
    ['priceCents null', { printDefaults: [{ ...validPd, priceCents: null }] }, ['printDefaults.0.priceCents']],
    ['priceCents string', { printDefaults: [{ ...validPd, priceCents: '15' }] }, ['printDefaults.0.priceCents']],
    ['costCents negative', { printDefaults: [{ ...validPd, costCents: -1 }] }, ['printDefaults.0.costCents']],
    ['priceCents too large', { printDefaults: [{ ...validPd, priceCents: 100000001 }] }, ['printDefaults.0.priceCents']],
    ['duplicate print code', { printDefaults: [validPd, { ...validPd, name: 'other' }] }, ['printDefaults.1.code']],
    ['bad code lowercase', { printDefaults: [{ ...validPd, code: 'abc' }] }, ['printDefaults.0.code']],
    ['bad code too long', { printDefaults: [{ ...validPd, code: 'A'.repeat(21) }] }, ['printDefaults.0.code']],
    ['bad code with dash', { printDefaults: [{ ...validPd, code: 'A-B' }] }, ['printDefaults.0.code']],
    ['print name blank', { printDefaults: [{ ...validPd, name: '  ' }] }, ['printDefaults.0.name']],
    ['print name > 60', { printDefaults: [{ ...validPd, name: 'x'.repeat(61) }] }, ['printDefaults.0.name']],
    ['empty printDefaults array', { printDefaults: [] }, ['printDefaults']],
    ['31 printDefaults items', { printDefaults: Array.from({ length: 31 }, (_, i) => ({ ...validPd, code: `C${i}` })) }, ['printDefaults']],
    ['printDefaults not an array', { printDefaults: {} }, ['printDefaults']],
    ['shop is null', { shop: null }, ['shop']],
  ];

  it.each(cases)('400 VALIDATION_ERROR: %s', async (_label, body, paths) => {
    const { app } = await env.build();
    const before = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json();
    const res = await put(app, body);
    expect(res.statusCode).toBe(400);
    const e = res.json().error;
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(typeof e.message).toBe('string');
    for (const p of paths) expect(Object.keys(e.fields)).toContain(p);
    // Nothing changed
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings' })).json()).toEqual(before);
    expect((await audit(app)).items).toHaveLength(0);
  });

  it('malformed JSON body -> 400 VALIDATION_ERROR', async () => {
    const { app } = await env.build();
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/settings',
      headers: { 'content-type': 'application/json' }, payload: '{"shop": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('no body at all -> 400 VALIDATION_ERROR', async () => {
    const { app } = await env.build();
    const res = await app.inject({ method: 'PUT', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  // Saved settings must survive a restart of the app on the same data folder.
  it('settings persist across app rebuild on the same dataDir', async () => {
    const first = await env.build();
    await put(first.app, { rates: { reloadCommissionBp: 123, ezcashCommissionBp: 45 } });
    await first.app.close();
    const second = await env.build({ dataDir: first.dataDir });
    const b = (await second.app.inject({ method: 'GET', url: '/api/v1/settings' })).json();
    expect(b.rates).toEqual({ reloadCommissionBp: 123, ezcashCommissionBp: 45 });
    expect(b.updatedAt).not.toBeNull();
  });
});
