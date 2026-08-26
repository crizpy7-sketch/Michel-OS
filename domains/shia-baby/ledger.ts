/**
 * Michel-OS — Shia Baby inventory, sales, expenses and tax set-aside (Agent J2).
 *
 * PRODUCT_SPEC §6 is explicit: "Do not build full accounting." This module is
 * therefore a *ledger*, not a book of accounts. It has three rules that make
 * that distinction real rather than aspirational:
 *
 *   1. Money is integer cents, everywhere, with no exceptions. A float `0.1 +
 *      0.2` reconciliation error is invisible until a quarter closes wrong.
 *      Nothing here ever divides money without saying what happens to the
 *      remainder.
 *   2. Inventory is an append-only movement log (§5). `quantityOnHand` is a
 *      projection of those rows, so a miscount is corrected by adding a
 *      compensating movement, never by overwriting a counter — the history is
 *      the point.
 *   3. Tax Set-Aside is an ESTIMATE and says so (§8). It is never labelled
 *      "taxes owed", and every summary carries its disclaimer as data so a UI
 *      cannot render the number without it.
 *
 * Pure: no clock, no ids. Every period boundary is computed from an explicit
 * window and timezone the caller supplies.
 */

import { authorize } from '../household/permissions.ts';
import {
  err,
  ok,
  type Business,
  type Expense,
  type Instant,
  type InventoryMovement,
  type Member,
  type MovementKind,
  type Product,
  type Result,
  type Sale,
  type UUID,
  type ValidationIssue,
} from '../../lib/contracts/index.ts';

/* ---------------------------------------------------------------- helpers */

function issue(path: string, message: string, code: ValidationIssue['code']): ValidationIssue {
  return { path, message, code };
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isWholeCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

/**
 * Cached per zone: a monthly rollup buckets every sale, and constructing a
 * formatter per row is the single most expensive thing in this file.
 */
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = DATE_FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-CA', options);
  } catch {
    dtf = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' });
  }
  DATE_FORMATTERS.set(timezone, dtf);
  return dtf;
}

/** Local calendar date (YYYY-MM-DD) for an instant, in the business timezone. */
function localDate(ms: number, timezone: string): string {
  return dateFormatterFor(timezone).format(new Date(ms)); // en-CA renders exactly YYYY-MM-DD
}

function financeGate(
  actor: Member,
  householdId: UUID,
  permission: 'finance.read' | 'finance.manage' | 'business.manage',
): ValidationIssue | null {
  const verdict = authorize({ member: actor, householdId, permission, resource: { householdId } });
  if (verdict.allowed) return null;
  return issue('actor', verdict.reason, verdict.code === 'tenant' ? 'tenant' : 'permission');
}

/* -------------------------------------------------------------- inventory */

/** Movement kinds that must reduce stock, and those that must increase it. */
const SIGN_OF: Readonly<Record<MovementKind, -1 | 1 | 0>> = Object.freeze({
  receive: 1,
  return: 1,
  sale: -1,
  shrinkage: -1,
  adjustment: 0, // the only kind that may go either way
});

export interface RecordMovementInput {
  id: UUID;
  businessId: UUID;
  product: Product;
  actor: Member;
  householdId: UUID;
  kind: MovementKind;
  /** Signed. Its sign must agree with the kind, except for `adjustment`. */
  quantityDelta: number;
  at: Instant;
  unitCost?: number;
  note?: string;
}

export interface RecordedMovement {
  movement: InventoryMovement;
  /** The product with `quantityOnHand` reprojected. Persist both or neither. */
  product: Product;
}

/**
 * Append one inventory movement and reproject the product's stock level.
 *
 * A `receive` with a negative quantity is rejected rather than quietly negated:
 * it means the caller has a sign bug, and swallowing it would put the ledger
 * and reality permanently out of step. Stock is allowed to go negative — a real
 * shop discovers it has oversold — but the caller is told, because that is a
 * fact somebody needs to act on rather than an error to hide.
 */
export function recordMovement(input: RecordMovementInput): Result<RecordedMovement> {
  const denied = financeGate(input.actor, input.householdId, 'business.manage');
  if (denied) return err([denied]);

  const issues: ValidationIssue[] = [];

  if (input.product.businessId !== input.businessId) {
    issues.push(issue('product.businessId', 'This product belongs to another business.', 'tenant'));
  }
  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
    issues.push(issue('quantityDelta', 'A movement must be a non-zero whole number of units.', 'range'));
  } else {
    const expected = SIGN_OF[input.kind];
    if (expected === undefined) {
      issues.push(issue('kind', `Unknown movement kind "${String(input.kind)}".`, 'enum'));
    } else if (expected !== 0 && Math.sign(input.quantityDelta) !== expected) {
      issues.push(
        issue(
          'quantityDelta',
          `A "${input.kind}" movement must be ${expected > 0 ? 'positive' : 'negative'}; ` +
            `record an "adjustment" if the correction really goes the other way.`,
          'logic',
        ),
      );
    }
  }
  if (parseInstant(input.at) === null) {
    issues.push(issue('at', 'A movement needs an ISO-8601 instant.', 'format'));
  }
  if (input.unitCost !== undefined && (typeof input.unitCost !== 'number' || input.unitCost < 0)) {
    issues.push(issue('unitCost', 'Unit cost cannot be negative.', 'range'));
  }

  if (issues.length > 0) return err(issues);

  const movement: InventoryMovement = {
    id: input.id,
    businessId: input.businessId,
    productId: input.product.id,
    kind: input.kind,
    quantityDelta: input.quantityDelta,
    at: input.at,
    ...(input.unitCost === undefined ? {} : { unitCost: input.unitCost }),
    ...(input.note === undefined ? {} : { note: input.note }),
  };

  return ok({
    movement,
    product: { ...input.product, quantityOnHand: input.product.quantityOnHand + input.quantityDelta },
  });
}

/**
 * Project stock on hand from the movement log.
 *
 * The projection is the source of truth; a `Product.quantityOnHand` that
 * disagrees with it is drift worth surfacing, which is what
 * `reconcileInventory` is for.
 */
export function projectStock(
  businessId: UUID,
  movements: readonly InventoryMovement[],
): Record<UUID, number> {
  const stock: Record<UUID, number> = {};
  for (const movement of movements) {
    if (movement.businessId !== businessId) continue;
    if (!Number.isInteger(movement.quantityDelta)) continue;
    stock[movement.productId] = (stock[movement.productId] ?? 0) + movement.quantityDelta;
  }
  return stock;
}

export interface StockDrift {
  productId: UUID;
  sku: string;
  recorded: number;
  projected: number;
  /** recorded − projected. Positive means the counter claims more than the log. */
  difference: number;
}

export function reconcileInventory(
  businessId: UUID,
  products: readonly Product[],
  movements: readonly InventoryMovement[],
): StockDrift[] {
  const projected = projectStock(businessId, movements);
  return products
    .filter((p) => p.businessId === businessId)
    .map((p) => ({
      productId: p.id,
      sku: p.sku,
      recorded: p.quantityOnHand,
      projected: projected[p.id] ?? 0,
      difference: p.quantityOnHand - (projected[p.id] ?? 0),
    }))
    .filter((d) => d.difference !== 0)
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

export interface LowStockAlert {
  productId: UUID;
  sku: string;
  name: string;
  quantityOnHand: number;
  reorderPoint: number;
  /** How many units to buy to get back above the reorder point. Never negative. */
  suggestedOrder: number;
  severity: 'warning' | 'blocking';
}

/**
 * PRODUCT_SPEC §5: low-stock alerts.
 *
 * At or below the reorder point is a warning; out of stock (or negative, which
 * means oversold) is blocking, because the shop cannot sell what it does not
 * have. A reorder point of zero means "do not track" and never alerts — that is
 * the only way to opt a product out.
 */
export function lowStockAlerts(businessId: UUID, products: readonly Product[]): LowStockAlert[] {
  return products
    .filter((p) => p.businessId === businessId && p.reorderPoint > 0 && p.quantityOnHand <= p.reorderPoint)
    .map((p) => ({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      quantityOnHand: p.quantityOnHand,
      reorderPoint: p.reorderPoint,
      suggestedOrder: Math.max(0, p.reorderPoint * 2 - p.quantityOnHand),
      severity: p.quantityOnHand <= 0 ? ('blocking' as const) : ('warning' as const),
    }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

/* ------------------------------------------------------------------ sales */

export interface RecordSaleInput {
  id: UUID;
  businessId: UUID;
  actor: Member;
  householdId: UUID;
  at: Instant;
  items: Sale['items'];
  taxCollectedCents?: number;
  channel?: string;
}

export interface RecordedSale {
  sale: Sale;
  /** One `sale` movement per line, so stock follows the till automatically. */
  movements: Array<Omit<InventoryMovement, 'id'>>;
  totalCents: number;
}

/**
 * Record a sale and the stock movements it implies.
 *
 * The movements come back without ids: minting them here would mean inventing
 * identity, which this module does not do. The caller assigns ids and persists
 * the sale and its movements in one transaction — a sale whose stock movement
 * did not land is exactly the drift `reconcileInventory` would later report.
 */
export function recordSale(input: RecordSaleInput): Result<RecordedSale> {
  const denied = financeGate(input.actor, input.householdId, 'finance.manage');
  if (denied) return err([denied]);

  const issues: ValidationIssue[] = [];

  if (!Array.isArray(input.items) || input.items.length === 0) {
    issues.push(issue('items', 'A sale needs at least one line.', 'required'));
  }
  if (parseInstant(input.at) === null) {
    issues.push(issue('at', 'A sale needs an ISO-8601 instant.', 'format'));
  }
  if (input.taxCollectedCents !== undefined && !isWholeCents(input.taxCollectedCents)) {
    issues.push(issue('taxCollectedCents', 'Tax collected must be a whole number of cents.', 'type'));
  }

  (input.items ?? []).forEach((item, index) => {
    if (!Number.isInteger(item?.quantity) || item.quantity < 1) {
      issues.push(issue(`items[${index}].quantity`, 'Quantity must be a whole number of at least 1.', 'range'));
    }
    if (!isWholeCents(item?.unitPriceCents) || item.unitPriceCents < 0) {
      issues.push(
        issue(`items[${index}].unitPriceCents`, 'Unit price must be a whole, non-negative number of cents.', 'type'),
      );
    }
    if (typeof item?.productId !== 'string' || item.productId.length === 0) {
      issues.push(issue(`items[${index}].productId`, 'Every sale line names a product.', 'required'));
    }
  });

  if (issues.length > 0) return err(issues);

  const sale: Sale = {
    id: input.id,
    businessId: input.businessId,
    at: input.at,
    items: input.items.map((i) => ({ ...i })),
    ...(input.taxCollectedCents === undefined ? {} : { taxCollectedCents: input.taxCollectedCents }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
  };

  return ok({
    sale,
    movements: sale.items.map((item) => ({
      businessId: input.businessId,
      productId: item.productId,
      kind: 'sale' as const,
      quantityDelta: -item.quantity,
      at: input.at,
    })),
    totalCents: saleTotalCents(sale),
  });
}

/** Gross of a sale in cents, excluding any tax recorded separately. */
export function saleTotalCents(sale: Sale): number {
  return sale.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

export const SALES_PERIODS = ['day', 'week', 'month'] as const;
export type SalesPeriod = (typeof SALES_PERIODS)[number];

export interface SalesBucket {
  /** `2026-08-24` for a day, `2026-W35` for a week, `2026-08` for a month. */
  period: string;
  orderCount: number;
  grossCents: number;
  taxCollectedCents: number;
  /** Integer cents, rounded half-up. Zero when there are no orders. */
  averageOrderCents: number;
}

export interface ProductPerformance {
  productId: UUID;
  unitsSold: number;
  grossCents: number;
}

export interface SalesSummary {
  buckets: SalesBucket[];
  totalGrossCents: number;
  totalTaxCollectedCents: number;
  orderCount: number;
  /** Best sellers by gross, then units, then id — deterministic on every tie. */
  topProducts: ProductPerformance[];
  /** The same list from the other end; a product with no sales is not here at all. */
  slowProducts: ProductPerformance[];
}

/**
 * PRODUCT_SPEC §6: daily / weekly / monthly sales, orders, average order,
 * top and slow products.
 *
 * Bucketing is by the business's local calendar, not by UTC — a shop that
 * closes at 9pm local would otherwise see its evening trade land on tomorrow.
 */
export function summarizeSales(input: {
  businessId: UUID;
  sales: readonly Sale[];
  period: SalesPeriod;
  window?: { from: Instant; to: Instant };
  timezone?: string;
  /** How many rows `topProducts` / `slowProducts` carry. Defaults to 5. */
  limit?: number;
}): SalesSummary {
  const timezone = input.timezone ?? 'UTC';
  const limit = Number.isInteger(input.limit) && input.limit! > 0 ? input.limit! : 5;
  const from = input.window ? parseInstant(input.window.from) : null;
  const to = input.window ? parseInstant(input.window.to) : null;

  const buckets = new Map<string, SalesBucket>();
  const byProduct = new Map<UUID, ProductPerformance>();
  let totalGrossCents = 0;
  let totalTaxCollectedCents = 0;
  let orderCount = 0;

  for (const sale of input.sales) {
    if (sale.businessId !== input.businessId) continue;
    const at = parseInstant(sale.at);
    if (at === null) continue;
    if (from !== null && at < from) continue;
    if (to !== null && at >= to) continue;

    const gross = saleTotalCents(sale);
    const tax = isWholeCents(sale.taxCollectedCents) ? sale.taxCollectedCents : 0;
    totalGrossCents += gross;
    totalTaxCollectedCents += tax;
    orderCount += 1;

    const key = periodKey(at, input.period, timezone);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.orderCount += 1;
      bucket.grossCents += gross;
      bucket.taxCollectedCents += tax;
    } else {
      buckets.set(key, {
        period: key,
        orderCount: 1,
        grossCents: gross,
        taxCollectedCents: tax,
        averageOrderCents: 0,
      });
    }

    for (const item of sale.items) {
      const performance = byProduct.get(item.productId);
      const lineGross = item.quantity * item.unitPriceCents;
      if (performance) {
        performance.unitsSold += item.quantity;
        performance.grossCents += lineGross;
      } else {
        byProduct.set(item.productId, {
          productId: item.productId,
          unitsSold: item.quantity,
          grossCents: lineGross,
        });
      }
    }
  }

  const ordered = [...buckets.values()]
    .map((b) => ({ ...b, averageOrderCents: divideCents(b.grossCents, b.orderCount) }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  const performances = [...byProduct.values()].sort(compareByGross);

  return {
    buckets: ordered,
    totalGrossCents,
    totalTaxCollectedCents,
    orderCount,
    topProducts: performances.slice(0, limit),
    slowProducts: [...performances].reverse().slice(0, limit),
  };
}

function compareByGross(a: ProductPerformance, b: ProductPerformance): number {
  if (a.grossCents !== b.grossCents) return b.grossCents - a.grossCents;
  if (a.unitsSold !== b.unitsSold) return b.unitsSold - a.unitsSold;
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
}

/** Integer division of cents, rounded half-up. Zero denominators yield zero. */
function divideCents(totalCents: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.round(totalCents / count);
}

function periodKey(ms: number, period: SalesPeriod, timezone: string): string {
  const date = localDate(ms, timezone); // YYYY-MM-DD
  if (period === 'day') return date;
  if (period === 'month') return date.slice(0, 7);

  // ISO week: Thursday of the same week decides the year, so a week that
  // straddles New Year gets one label instead of two.
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(year, month - 1, day);
  const weekday = (new Date(utc).getUTCDay() + 6) % 7; // MO=0 … SU=6
  const thursday = utc + (3 - weekday) * 86_400_000;
  const thursdayDate = new Date(thursday);
  const isoYear = thursdayDate.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Weekday * 86_400_000;
  const weekNumber = Math.floor((thursday - week1Monday) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`;
}

/* --------------------------------------------------------------- expenses */

export interface RecordExpenseInput {
  id: UUID;
  businessId: UUID;
  actor: Member;
  householdId: UUID;
  at: Instant;
  vendor: string;
  category: string;
  amountCents: number;
  description?: string;
  receiptAttachmentId?: UUID;
}

export function recordExpense(input: RecordExpenseInput): Result<Expense> {
  const denied = financeGate(input.actor, input.householdId, 'finance.manage');
  if (denied) return err([denied]);

  const issues: ValidationIssue[] = [];
  const vendor = typeof input.vendor === 'string' ? input.vendor.trim() : '';
  const category = typeof input.category === 'string' ? input.category.trim() : '';

  if (vendor.length === 0) issues.push(issue('vendor', 'An expense needs a vendor.', 'required'));
  if (category.length === 0) issues.push(issue('category', 'An expense needs a category.', 'required'));
  if (!isWholeCents(input.amountCents) || input.amountCents <= 0) {
    issues.push(issue('amountCents', 'An expense must be a positive whole number of cents.', 'range'));
  }
  if (parseInstant(input.at) === null) {
    issues.push(issue('at', 'An expense needs an ISO-8601 instant.', 'format'));
  }

  if (issues.length > 0) return err(issues);

  return ok({
    id: input.id,
    businessId: input.businessId,
    at: input.at,
    vendor,
    category,
    amountCents: input.amountCents,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.receiptAttachmentId === undefined ? {} : { receiptAttachmentId: input.receiptAttachmentId }),
  });
}

export interface ExpenseSummary {
  totalCents: number;
  /** Sorted by spend descending, then by category name. */
  byCategory: Array<{ category: string; totalCents: number; count: number }>;
  /** Expenses with no receipt attached — the ones that will hurt at tax time. */
  missingReceipts: UUID[];
}

export function summarizeExpenses(input: {
  businessId: UUID;
  expenses: readonly Expense[];
  window?: { from: Instant; to: Instant };
}): ExpenseSummary {
  const from = input.window ? parseInstant(input.window.from) : null;
  const to = input.window ? parseInstant(input.window.to) : null;

  const byCategory = new Map<string, { category: string; totalCents: number; count: number }>();
  const missingReceipts: UUID[] = [];
  let totalCents = 0;

  for (const expense of input.expenses) {
    if (expense.businessId !== input.businessId) continue;
    const at = parseInstant(expense.at);
    if (at === null) continue;
    if (from !== null && at < from) continue;
    if (to !== null && at >= to) continue;
    if (!isWholeCents(expense.amountCents)) continue;

    totalCents += expense.amountCents;
    if (expense.receiptAttachmentId === undefined) missingReceipts.push(expense.id);

    const key = expense.category.toLowerCase();
    const bucket = byCategory.get(key);
    if (bucket) {
      bucket.totalCents += expense.amountCents;
      bucket.count += 1;
      if (expense.category < bucket.category) bucket.category = expense.category;
    } else {
      byCategory.set(key, { category: expense.category, totalCents: expense.amountCents, count: 1 });
    }
  }

  return {
    totalCents,
    byCategory: [...byCategory.values()].sort((a, b) =>
      a.totalCents !== b.totalCents ? b.totalCents - a.totalCents : a.category < b.category ? -1 : 1,
    ),
    missingReceipts: missingReceipts.sort(),
  };
}

/* -------------------------------------------------------- tax set-aside */

/**
 * PRODUCT_SPEC §8 is a naming requirement, not a preference: the label is
 * "Tax Set-Aside", never "Taxes Owed", unless the system is connected to
 * authoritative accounting — which it is not.
 *
 * The disclaimer travels as a field on the summary rather than as UI copy, so
 * a screen cannot render the number without the caveat that goes with it.
 */
export const TAX_SET_ASIDE_LABEL = 'Tax Set-Aside';

export const TAX_SET_ASIDE_DISCLAIMER =
  'This is an estimated reserve, not a tax filing and not a professional tax calculation. ' +
  'Confirm the figure with your accountant before relying on it.';

export interface TaxSetAsideSummary {
  label: typeof TAX_SET_ASIDE_LABEL;
  disclaimer: string;
  /** Gross sales in the window that the estimate is based on. */
  taxableSalesCents: number;
  /** Tax actually recorded at the till, when the till records it. */
  taxCollectedCents: number;
  /** The rate the estimate used, 0..1. */
  rate: number;
  /** taxableSales × rate, rounded half-up to whole cents. */
  estimatedReserveCents: number;
  /** What has already been put aside, as reported by the caller. */
  reservedCents: number;
  /** estimatedReserve − reserved, floored at zero: never a negative "owed". */
  remainingReserveCents: number;
  /** True when more has been reserved than the estimate calls for. */
  overReserved: boolean;
}

export function estimateTaxSetAside(input: {
  business: Business;
  sales: readonly Sale[];
  actor: Member;
  householdId: UUID;
  /** Cents already moved into the set-aside account. */
  reservedCents?: number;
  window?: { from: Instant; to: Instant };
}): Result<TaxSetAsideSummary> {
  const denied = financeGate(input.actor, input.householdId, 'finance.read');
  if (denied) return err([denied]);

  const rate = input.business.taxSetAsideRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    return err([issue('business.taxSetAsideRate', 'The set-aside rate must be between 0 and 1.', 'range')]);
  }

  const reservedCents = input.reservedCents ?? 0;
  if (!isWholeCents(reservedCents) || reservedCents < 0) {
    return err([issue('reservedCents', 'Reserved must be a whole, non-negative number of cents.', 'range')]);
  }

  const summary = summarizeSales({
    businessId: input.business.id,
    sales: input.sales,
    period: 'month',
    ...(input.window === undefined ? {} : { window: input.window }),
    timezone: input.business.timezone,
  });

  const estimatedReserveCents = Math.round(summary.totalGrossCents * rate);

  return ok({
    label: TAX_SET_ASIDE_LABEL,
    disclaimer: TAX_SET_ASIDE_DISCLAIMER,
    taxableSalesCents: summary.totalGrossCents,
    taxCollectedCents: summary.totalTaxCollectedCents,
    rate,
    estimatedReserveCents,
    reservedCents,
    // Floored deliberately: a negative "remaining" would read as money owed
    // back, which this module is explicitly not qualified to assert.
    remainingReserveCents: Math.max(0, estimatedReserveCents - reservedCents),
    overReserved: reservedCents > estimatedReserveCents,
  });
}
