-- Produtos compostos (kits) e expansao de estoque.
--
-- Um kit nao possui estoque fisico proprio: ele e uma forma comercial de
-- vender/alugar seus componentes. Todo o controle de estoque continua
-- acontecendo nos produtos simples.

-- 1. Tipo do produto. Tudo que ja existe continua sendo produto simples.
ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'simples';

-- 2. Composicao do kit: quais produtos simples formam o kit e em que quantidade.
CREATE TABLE IF NOT EXISTS product_components (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (parent_product_id, component_product_id),
  CHECK (parent_product_id <> component_product_id)
);
CREATE INDEX IF NOT EXISTS idx_pcomp_parent ON product_components(parent_product_id);
CREATE INDEX IF NOT EXISTS idx_pcomp_component ON product_components(component_product_id);

-- 3. Fotografia da composicao no momento da reserva.
--
--    Cada linha comercial da reserva (reservation_items) e expandida aqui nos
--    produtos fisicos que realmente ocupam estoque. Produtos simples geram uma
--    linha identica a si mesmos; kits geram uma linha por componente.
--
--    Guardar a expansao no momento da operacao preserva a integridade
--    historica: alterar a composicao de um kit depois nao muda reservas ja
--    registradas.
CREATE TABLE IF NOT EXISTS reservation_item_components (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id      INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  reservation_item_id INTEGER NOT NULL REFERENCES reservation_items(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id),
  qty_per_unit        INTEGER NOT NULL DEFAULT 1,
  qty                 INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ricomp_res ON reservation_item_components(reservation_id);
CREATE INDEX IF NOT EXISTS idx_ricomp_item ON reservation_item_components(reservation_item_id);
CREATE INDEX IF NOT EXISTS idx_ricomp_prod ON reservation_item_components(product_id);

-- 4. Backfill: tudo que ja existe e produto simples, logo a expansao e 1:1.
INSERT INTO reservation_item_components (reservation_id, reservation_item_id, product_id, qty_per_unit, qty)
SELECT i.reservation_id, i.id, i.product_id, 1, i.qty
  FROM reservation_items i
 WHERE NOT EXISTS (
   SELECT 1 FROM reservation_item_components c WHERE c.reservation_item_id = i.id
 );
