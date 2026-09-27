-- Promocao por quantidade. Somente tabelas novas: o preco normal do produto
-- (products.rent_price_cents) continua sendo a fonte da verdade e nao e tocado.
-- Documentos ja salvos guardam o preco em reservation_items/quote_items, entao
-- alterar uma promocao nunca reescreve valor de documento existente.
CREATE TABLE IF NOT EXISTS promotions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  starts_on   TEXT,
  ends_on     TEXT,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_promotions_product ON promotions(product_id, active);

CREATE TABLE IF NOT EXISTS promotion_tiers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id     INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  min_qty          INTEGER NOT NULL,
  -- NULL e "sem limite": a faixa vale para qualquer quantidade acima do minimo
  max_qty          INTEGER,
  unit_price_cents INTEGER NOT NULL,
  CHECK (min_qty >= 1),
  CHECK (max_qty IS NULL OR max_qty >= min_qty),
  CHECK (unit_price_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_promotion_tiers ON promotion_tiers(promotion_id, min_qty);
