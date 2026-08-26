/**
 * Unit tests for the Shia Baby ledger (Agent J2, domains/shia-baby/ledger.ts).
 *
 * The three invariants under attack throughout: money never leaves integer
 * cents, inventory is a log rather than a counter, and the tax figure is never
 * separable from its disclaimer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TAX_SET_ASIDE_DISCLAIMER,
  TAX_SET_ASIDE_LABEL,
  estimateTaxSetAside,
  lowStockAlerts,
  projectStock,
  recordExpense,
  recordMovement,
  recordSale,
  reconcileInventory,
  saleTotalCents,
  summarizeExpenses,
  summarizeSales,
} from '../../domains/shia-baby/ledger.ts';
import type {
  Business,
  Expense,
  InventoryMovement,
  Member,
  Product,
  Role,
  Sale,
  UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------- fixtures */

const HOUSEHOLD: UUID = 'hh-michel';
const BUSINESS: UUID = 'biz-shia-baby';
const OTHER_BUSINESS: UUID = 'biz-somebody-else';

function member(id: UUID, role: Role, householdId: UUID = HOUSEHOLD): Member {
  return { id, householdId, userId: null, displayName: id, role, color: 'slate', active: true };
}

const owner = member('m-owner', 'owner');
const adult = member('m-adult', 'adult'); // finance.read but not finance.manage
const viewer = member('m-viewer', 'viewer');

const business: Business = {
  id: BUSINESS,
  householdId: HOUSEHOLD,
  name: 'Shia Baby',
  timezone: 'America/Chicago',
  taxSetAsideRate: 0.0825,
};

function product(id: UUID, sku: string, patch: Partial<Product> = {}): Product {
  return {
    id,
    businessId: BUSINESS,
    sku,
    name: sku,
    quantityOnHand: 10,
    reorderPoint: 4,
    unitCost: 500,
    unitPrice: 1200,
    ...patch,
  };
}

const bear = product('p-bear', 'BEAR-01', { name: 'Classic teddy' });

function sale(id: UUID, at: string, items: Sale['items'], patch: Partial<Sale> = {}): Sale {
  return { id, businessId: BUSINESS, at, items, ...patch };
}

function value<T>(result: { ok: true; value: T } | { ok: false; issues: unknown[] }): T {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return (result as { ok: true; value: T }).value;
}

function issues(result: { ok: boolean; issues?: unknown[] }): Array<{ code: string; path: string; message: string }> {
  assert.equal(result.ok, false, 'expected a rejection');
  return (result as { issues: Array<{ code: string; path: string; message: string }> }).issues;
}

const AT = '2026-08-24T15:00:00.000Z';

/* -------------------------------------------------------------- inventory */

test('recordMovement: receiving stock appends a movement and reprojects the product', () => {
  const result = value(
    recordMovement({
      id: 'mv-1',
      businessId: BUSINESS,
      product: bear,
      actor: owner,
      householdId: HOUSEHOLD,
      kind: 'receive',
      quantityDelta: 12,
      at: AT,
    }),
  );
  assert.equal(result.movement.quantityDelta, 12);
  assert.equal(result.product.quantityOnHand, 22);
  assert.equal(bear.quantityOnHand, 10, 'the product handed in is not mutated');
});

test('recordMovement: a sign that disagrees with the kind is a rejection, not a silent negation', () => {
  const backwards = recordMovement({
    id: 'mv-1',
    businessId: BUSINESS,
    product: bear,
    actor: owner,
    householdId: HOUSEHOLD,
    kind: 'receive',
    quantityDelta: -12,
    at: AT,
  });
  assert.match(issues(backwards)[0]!.message, /must be positive/);

  const sale_up = recordMovement({
    id: 'mv-2',
    businessId: BUSINESS,
    product: bear,
    actor: owner,
    householdId: HOUSEHOLD,
    kind: 'sale',
    quantityDelta: 3,
    at: AT,
  });
  assert.match(issues(sale_up)[0]!.message, /must be negative/);
});

test('recordMovement: an adjustment is the only kind allowed to go either way', () => {
  for (const delta of [-3, 3]) {
    assert.equal(
      recordMovement({
        id: 'mv-1',
        businessId: BUSINESS,
        product: bear,
        actor: owner,
        householdId: HOUSEHOLD,
        kind: 'adjustment',
        quantityDelta: delta,
        at: AT,
      }).ok,
      true,
    );
  }
});

test('recordMovement: stock may go negative — a shop can discover it oversold', () => {
  const result = value(
    recordMovement({
      id: 'mv-1',
      businessId: BUSINESS,
      product: product('p-thin', 'THIN-01', { quantityOnHand: 1 }),
      actor: owner,
      householdId: HOUSEHOLD,
      kind: 'sale',
      quantityDelta: -3,
      at: AT,
    }),
  );
  assert.equal(result.product.quantityOnHand, -2, 'the truth is recorded, not clamped away');
});

test('recordMovement: a zero movement, a foreign product and a bad instant are all refused', () => {
  assert.deepEqual(
    issues(
      recordMovement({
        id: 'mv-1',
        businessId: BUSINESS,
        product: product('p-x', 'X', { businessId: OTHER_BUSINESS }),
        actor: owner,
        householdId: HOUSEHOLD,
        kind: 'receive',
        quantityDelta: 0,
        at: 'whenever',
      }),
    )
      .map((i) => i.path)
      .sort(),
    ['at', 'product.businessId', 'quantityDelta'],
  );
});

test('recordMovement: only business.manage may touch stock', () => {
  for (const actor of [adult, viewer]) {
    assert.deepEqual(
      issues(
        recordMovement({
          id: 'mv-1',
          businessId: BUSINESS,
          product: bear,
          actor,
          householdId: HOUSEHOLD,
          kind: 'receive',
          quantityDelta: 1,
          at: AT,
        }),
      ).map((i) => i.code),
      ['permission'],
    );
  }
});

test('projectStock: the log is the source of truth, and another shop’s rows are ignored', () => {
  const movements: InventoryMovement[] = [
    { id: 'a', businessId: BUSINESS, productId: 'p-bear', kind: 'receive', quantityDelta: 20, at: AT },
    { id: 'b', businessId: BUSINESS, productId: 'p-bear', kind: 'sale', quantityDelta: -3, at: AT },
    { id: 'c', businessId: BUSINESS, productId: 'p-bear', kind: 'shrinkage', quantityDelta: -1, at: AT },
    { id: 'd', businessId: OTHER_BUSINESS, productId: 'p-bear', kind: 'receive', quantityDelta: 500, at: AT },
  ];
  assert.deepEqual(projectStock(BUSINESS, movements), { 'p-bear': 16 });
});

test('reconcileInventory: drift between the counter and the log is surfaced, agreement is silent', () => {
  const movements: InventoryMovement[] = [
    { id: 'a', businessId: BUSINESS, productId: 'p-bear', kind: 'receive', quantityDelta: 10, at: AT },
  ];
  assert.deepEqual(reconcileInventory(BUSINESS, [bear], movements), []);

  const drifted = reconcileInventory(BUSINESS, [product('p-bear', 'BEAR-01', { quantityOnHand: 7 })], movements);
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0]!.difference, -3, 'the counter claims three fewer than the log');
});

test('lowStockAlerts: at the reorder point warns, out of stock is blocking, zero point opts out', () => {
  const alerts = lowStockAlerts(BUSINESS, [
    product('p-a', 'A', { quantityOnHand: 4, reorderPoint: 4 }),
    product('p-b', 'B', { quantityOnHand: 0, reorderPoint: 4 }),
    product('p-c', 'C', { quantityOnHand: 5, reorderPoint: 4 }),
    product('p-d', 'D', { quantityOnHand: 0, reorderPoint: 0 }),
  ]);
  assert.deepEqual(alerts.map((a) => a.sku), ['A', 'B']);
  assert.equal(alerts[0]!.severity, 'warning');
  assert.equal(alerts[1]!.severity, 'blocking');
  assert.equal(alerts[0]!.suggestedOrder, 4, 'order back up above the reorder point');
});

test('lowStockAlerts: an oversold product never suggests a negative order', () => {
  const [alert] = lowStockAlerts(BUSINESS, [product('p-a', 'A', { quantityOnHand: -20, reorderPoint: 2 })]);
  assert.ok(alert);
  assert.ok(alert.suggestedOrder >= 0, `suggested ${alert.suggestedOrder}`);
});

/* ------------------------------------------------------------------ sales */

test('recordSale: a sale yields its total and one stock movement per line', () => {
  const result = value(
    recordSale({
      id: 'sale-1',
      businessId: BUSINESS,
      actor: owner,
      householdId: HOUSEHOLD,
      at: AT,
      items: [
        { productId: 'p-bear', quantity: 2, unitPriceCents: 1250 },
        { productId: 'p-hat', quantity: 1, unitPriceCents: 799 },
      ],
      taxCollectedCents: 271,
    }),
  );
  assert.equal(result.totalCents, 3299);
  assert.deepEqual(result.movements.map((m) => m.quantityDelta), [-2, -1]);
  assert.ok(result.movements.every((m) => m.kind === 'sale'));
  assert.equal(Object.hasOwn(result.movements[0]!, 'id'), false, 'ids are the caller’s to mint');
});

test('recordSale: fractional cents and empty lines are rejected, every problem at once', () => {
  const rejected = recordSale({
    id: 'sale-1',
    businessId: BUSINESS,
    actor: owner,
    householdId: HOUSEHOLD,
    at: AT,
    items: [
      { productId: 'p-bear', quantity: 1, unitPriceCents: 12.5 },
      { productId: '', quantity: 0, unitPriceCents: 100 },
    ],
  });
  const paths = issues(rejected).map((i) => i.path).sort();
  assert.deepEqual(paths, ['items[0].unitPriceCents', 'items[1].productId', 'items[1].quantity']);
});

test('recordSale: an adult holds finance.read only and cannot record a sale', () => {
  assert.deepEqual(
    issues(
      recordSale({
        id: 'sale-1',
        businessId: BUSINESS,
        actor: adult,
        householdId: HOUSEHOLD,
        at: AT,
        items: [{ productId: 'p-bear', quantity: 1, unitPriceCents: 100 }],
      }),
    ).map((i) => i.code),
    ['permission'],
  );
});

test('saleTotalCents: totals stay exact where floating-point dollars would drift', () => {
  const total = saleTotalCents(
    sale('s', AT, Array.from({ length: 10 }, () => ({ productId: 'p', quantity: 1, unitPriceCents: 10 }))),
  );
  assert.equal(total, 100, 'ten dimes are exactly one dollar');
  assert.ok(Number.isInteger(total));
});

test('summarizeSales: daily buckets follow the business’s local calendar, not UTC', () => {
  // 2026-08-25T02:00Z is still the evening of the 24th in America/Chicago.
  const summary = summarizeSales({
    businessId: BUSINESS,
    sales: [
      sale('s1', '2026-08-24T18:00:00.000Z', [{ productId: 'p-bear', quantity: 1, unitPriceCents: 1000 }]),
      sale('s2', '2026-08-25T02:00:00.000Z', [{ productId: 'p-bear', quantity: 1, unitPriceCents: 1000 }]),
    ],
    period: 'day',
    timezone: business.timezone,
  });
  assert.deepEqual(summary.buckets.map((b) => b.period), ['2026-08-24'], 'evening trade stays on its own day');
  assert.equal(summary.buckets[0]!.orderCount, 2);
});

test('summarizeSales: average order is whole cents, rounded half-up', () => {
  const summary = summarizeSales({
    businessId: BUSINESS,
    sales: [
      sale('s1', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
      sale('s2', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 101 }]),
      sale('s3', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
    ],
    period: 'month',
  });
  assert.equal(summary.buckets[0]!.averageOrderCents, 100);
  assert.ok(Number.isInteger(summary.buckets[0]!.averageOrderCents));
});

test('summarizeSales: weekly buckets use ISO weeks and survive a year boundary', () => {
  const summary = summarizeSales({
    businessId: BUSINESS,
    sales: [
      sale('s1', '2026-12-31T15:00:00.000Z', [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
      sale('s2', '2027-01-01T15:00:00.000Z', [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
    ],
    period: 'week',
    timezone: 'UTC',
  });
  assert.equal(summary.buckets.length, 1, 'one week, one label — 31 Dec and 1 Jan 2027 are the same ISO week');
  assert.equal(summary.buckets[0]!.orderCount, 2);
});

test('summarizeSales: top and slow products are deterministic on every tie', () => {
  const sales = [
    sale('s1', AT, [
      { productId: 'p-b', quantity: 1, unitPriceCents: 500 },
      { productId: 'p-a', quantity: 1, unitPriceCents: 500 },
      { productId: 'p-c', quantity: 5, unitPriceCents: 1000 },
    ]),
  ];
  const forward = summarizeSales({ businessId: BUSINESS, sales, period: 'month' });
  const shuffled = summarizeSales({
    businessId: BUSINESS,
    sales: [sale('s1', AT, [...sales[0]!.items].reverse())],
    period: 'month',
  });

  assert.deepEqual(forward.topProducts.map((p) => p.productId), ['p-c', 'p-a', 'p-b']);
  assert.deepEqual(forward.topProducts, shuffled.topProducts, 'line order must not decide the ranking');
  assert.deepEqual(forward.slowProducts.map((p) => p.productId), ['p-b', 'p-a', 'p-c']);
});

test('summarizeSales: the window is half-open and another shop’s sales never count', () => {
  const summary = summarizeSales({
    businessId: BUSINESS,
    sales: [
      sale('s-before', '2026-08-23T23:59:59.000Z', [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
      sale('s-in', '2026-08-24T00:00:00.000Z', [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
      sale('s-edge', '2026-08-25T00:00:00.000Z', [{ productId: 'p', quantity: 1, unitPriceCents: 100 }]),
      { ...sale('s-foreign', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 9999 }]), businessId: OTHER_BUSINESS },
    ],
    period: 'day',
    window: { from: '2026-08-24T00:00:00.000Z', to: '2026-08-25T00:00:00.000Z' },
    timezone: 'UTC',
  });
  assert.equal(summary.orderCount, 1);
  assert.equal(summary.totalGrossCents, 100);
});

/* --------------------------------------------------------------- expenses */

test('recordExpense: a valid expense is trimmed and kept in whole cents', () => {
  const expense = value(
    recordExpense({
      id: 'ex-1',
      businessId: BUSINESS,
      actor: owner,
      householdId: HOUSEHOLD,
      at: AT,
      vendor: '  Fabric Depot  ',
      category: ' Materials ',
      amountCents: 4599,
    }),
  );
  assert.equal(expense.vendor, 'Fabric Depot');
  assert.equal(expense.category, 'Materials');
  assert.equal(Object.hasOwn(expense, 'receiptAttachmentId'), false);
});

test('recordExpense: a zero or fractional amount is refused', () => {
  for (const amountCents of [0, -100, 45.99]) {
    assert.equal(
      recordExpense({
        id: 'ex-1',
        businessId: BUSINESS,
        actor: owner,
        householdId: HOUSEHOLD,
        at: AT,
        vendor: 'V',
        category: 'C',
        amountCents,
      }).ok,
      false,
      `${amountCents} should not be a valid expense`,
    );
  }
});

test('summarizeExpenses: categories merge case-insensitively and missing receipts are named', () => {
  const expenses: Expense[] = [
    { id: 'e1', businessId: BUSINESS, at: AT, vendor: 'A', category: 'Materials', amountCents: 1000 },
    { id: 'e2', businessId: BUSINESS, at: AT, vendor: 'B', category: 'materials', amountCents: 500, receiptAttachmentId: 'att-1' },
    { id: 'e3', businessId: BUSINESS, at: AT, vendor: 'C', category: 'Shipping', amountCents: 2000 },
    { id: 'e4', businessId: OTHER_BUSINESS, at: AT, vendor: 'D', category: 'Materials', amountCents: 9999 },
  ];
  const summary = summarizeExpenses({ businessId: BUSINESS, expenses });

  assert.equal(summary.totalCents, 3500);
  assert.deepEqual(summary.byCategory.map((c) => [c.category, c.totalCents]), [
    ['Shipping', 2000],
    ['Materials', 1500],
  ]);
  assert.deepEqual(summary.missingReceipts, ['e1', 'e3']);
});

/* -------------------------------------------------------- tax set-aside */

test('estimateTaxSetAside: the label is never "Taxes Owed" and the disclaimer travels with the number', () => {
  const summary = value(
    estimateTaxSetAside({
      business,
      sales: [sale('s1', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 100_000 }])],
      actor: owner,
      householdId: HOUSEHOLD,
    }),
  );
  assert.equal(summary.label, TAX_SET_ASIDE_LABEL);
  assert.equal(summary.label, 'Tax Set-Aside');
  assert.equal(summary.disclaimer, TAX_SET_ASIDE_DISCLAIMER);
  assert.match(summary.disclaimer, /not a tax filing/);
  assert.equal(/owed/i.test(summary.label), false, 'PRODUCT_SPEC §8 forbids the "owed" framing');
});

test('estimateTaxSetAside: the reserve is taxable sales × rate in whole cents', () => {
  const summary = value(
    estimateTaxSetAside({
      business,
      sales: [sale('s1', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 100_000 }])],
      actor: owner,
      householdId: HOUSEHOLD,
      reservedCents: 3000,
    }),
  );
  assert.equal(summary.taxableSalesCents, 100_000);
  assert.equal(summary.estimatedReserveCents, 8250); // 100000 × 0.0825
  assert.ok(Number.isInteger(summary.estimatedReserveCents));
  assert.equal(summary.remainingReserveCents, 5250);
  assert.equal(summary.overReserved, false);
});

test('estimateTaxSetAside: over-reserving reports zero remaining, never a negative amount owed', () => {
  const summary = value(
    estimateTaxSetAside({
      business,
      sales: [sale('s1', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 10_000 }])],
      actor: owner,
      householdId: HOUSEHOLD,
      reservedCents: 50_000,
    }),
  );
  assert.equal(summary.remainingReserveCents, 0);
  assert.equal(summary.overReserved, true, 'the fact is reported, just not as a negative liability');
});

test('estimateTaxSetAside: tax collected at the till is reported alongside, not instead of, the estimate', () => {
  const summary = value(
    estimateTaxSetAside({
      business,
      sales: [
        sale('s1', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 10_000 }], { taxCollectedCents: 825 }),
        sale('s2', AT, [{ productId: 'p', quantity: 1, unitPriceCents: 10_000 }]),
      ],
      actor: owner,
      householdId: HOUSEHOLD,
    }),
  );
  assert.equal(summary.taxCollectedCents, 825, 'only what the till actually recorded');
  assert.equal(summary.estimatedReserveCents, 1650, 'the estimate still covers both sales');
});

test('estimateTaxSetAside: an adult may read the estimate; a viewer may not', () => {
  assert.equal(estimateTaxSetAside({ business, sales: [], actor: adult, householdId: HOUSEHOLD }).ok, true);
  assert.deepEqual(
    issues(estimateTaxSetAside({ business, sales: [], actor: viewer, householdId: HOUSEHOLD })).map((i) => i.code),
    ['permission'],
  );
});

test('estimateTaxSetAside: a nonsense rate is refused rather than producing a confident wrong number', () => {
  for (const taxSetAsideRate of [-0.1, 1.5, Number.NaN]) {
    assert.equal(
      estimateTaxSetAside({
        business: { ...business, taxSetAsideRate },
        sales: [],
        actor: owner,
        householdId: HOUSEHOLD,
      }).ok,
      false,
      `rate ${taxSetAsideRate} should be refused`,
    );
  }
});

test('estimateTaxSetAside: a member of another household is refused as a tenant violation', () => {
  const intruder = member('m-intruder', 'owner', 'hh-elsewhere');
  assert.deepEqual(
    issues(estimateTaxSetAside({ business, sales: [], actor: intruder, householdId: HOUSEHOLD })).map((i) => i.code),
    ['tenant'],
  );
});
