-- 002_removals.sql — make removal possible without lying about history.
--
-- Everything else this repair needed already had somewhere honest to go: an
-- employee has `active`, a shift has a `cancelled` status, a shopping item has
-- `removed`, and a member has `active`. A product had nothing. Its only exits
-- were a DELETE that `sale_item ... on delete restrict` refuses outright once
-- anything has sold, and one that `inventory_movement ... on delete cascade`
-- would happily accept — silently taking the stock ledger with it.
--
-- So a product that has been sold or stocked is retired by stamping this
-- column, never by deleting the row: the sale lines keep pointing at a real
-- product, `reconcileInventory` keeps its movements, and the shop still stops
-- showing it. A product nothing references at all is still hard-deleted by the
-- API, because there is no history to protect and a mistyped test SKU should
-- leave no trace.
--
-- Nullable and with no default, so applying this to a live database archives
-- nothing: every existing product stays exactly as active as it was.

alter table product add column archived_at timestamptz;

-- The read path is "products still for sale", so index that, not the column.
-- A partial index over the live rows stays small no matter how much a shop
-- retires over the years.
create index product_live_idx on product (business_id) where archived_at is null;

comment on column product.archived_at is
  'When the product was retired. Non-null products are hidden from inventory, '
  'search and sales, and are kept only so recorded sales and stock movements '
  'still refer to something real.';
