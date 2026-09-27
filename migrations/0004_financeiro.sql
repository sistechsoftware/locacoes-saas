-- Gestao financeira: previsto x realizado.
--
-- O sistema ja tinha os dois livros do REALIZADO: payments (dinheiro que
-- entrou) e expenses (dinheiro que saiu). Eles continuam sendo a unica fonte
-- do caixa, e nada neles muda.
--
-- O que faltava era a camada do PREVISTO: o que a empresa tem direito a
-- receber e obrigacao de pagar antes de o dinheiro se mover. E o que estas
-- tabelas acrescentam. Uma locacao de R$2.000 em 4x cria quatro previsoes; o
-- caixa so registra a parcela quando ela e efetivamente paga.

-- Contas onde o dinheiro fica. O saldo corrente e o inicial mais as
-- movimentacoes, nunca um numero guardado que pode divergir.
CREATE TABLE IF NOT EXISTS financial_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'banco'
                        CHECK (kind IN ('banco','dinheiro','digital','poupanca','outro')),
  bank                  TEXT,
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  doc        TEXT,
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

-- Compras de equipamento e material.
--
-- affects_stock separa as duas modalidades pedidas: uma compra historica
-- registra o gasto passado sem mexer no estoque de hoje; uma compra atual
-- entra no estoque. stock_applied_qty guarda o que ja foi aplicado, para que
-- reabrir ou editar a compra ajuste apenas a diferenca em vez de somar de novo.
CREATE TABLE IF NOT EXISTS purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  supplier_id    INTEGER REFERENCES suppliers(id),
  purchase_date  TEXT NOT NULL,
  items_cents    INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  affects_stock  INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'investimento'
                 CHECK (kind IN ('investimento','operacional')),
  status         TEXT NOT NULL DEFAULT 'aberta'
                 CHECK (status IN ('aberta','cancelada')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id        INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  qty                INTEGER NOT NULL DEFAULT 1,
  unit_price_cents   INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  subtotal_cents     INTEGER NOT NULL DEFAULT 0,
  -- quanto deste item ja foi somado ao estoque; a diferenca e o que falta
  stock_applied_qty  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pitems_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pitems_product ON purchase_items(product_id);

-- Livro de movimentacao de estoque: registra toda entrada e saida com a sua
-- origem, para que uma compra cancelada possa ser estornada sem apagar
-- historico e para que nada seja aplicado duas vezes.
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty_delta   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stockmov_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_purchase ON stock_movements(purchase_id);

-- Previsoes: contas a receber e a pagar, uma linha por parcela.
--
-- direction separa as duas, que compartilham o mesmo ciclo (em aberto,
-- parcial, quitada, vencida, cancelada) e por isso vivem na mesma tabela,
-- como ja acontece com as operacoes de entrega e retirada.
--
-- O valor recebido/pago NAO fica aqui: ele e a soma dos lancamentos de caixa
-- (payments e expenses) que apontam para a parcela. Assim previsto e realizado
-- nunca divergem por esquecimento de atualizar um campo.
CREATE TABLE IF NOT EXISTS financial_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  number             TEXT NOT NULL UNIQUE,
  direction          TEXT NOT NULL CHECK (direction IN ('receber','pagar')),
  origin             TEXT NOT NULL DEFAULT 'outro'
                     CHECK (origin IN ('locacao','frete','compra','despesa','outro')),
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  supplier_id        INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  reservation_id     INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  freight_id         INTEGER REFERENCES freights(id) ON DELETE CASCADE,
  purchase_id        INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
  category           TEXT,
  description        TEXT,
  amount_cents       INTEGER NOT NULL,
  due_date           TEXT NOT NULL,
  installment        INTEGER NOT NULL DEFAULT 1,
  installments_total INTEGER NOT NULL DEFAULT 1,
  account_id         INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'aberta'
                     CHECK (status IN ('aberta','quitada','cancelada')),
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_entries_direction ON financial_entries(direction, status);
CREATE INDEX IF NOT EXISTS idx_entries_due ON financial_entries(due_date);
CREATE INDEX IF NOT EXISTS idx_entries_purchase ON financial_entries(purchase_id);
CREATE INDEX IF NOT EXISTS idx_entries_reservation ON financial_entries(reservation_id);

-- Ligacao do realizado com o previsto. Colunas novas e opcionais: as linhas
-- que ja existem continuam validas sem nenhuma delas.
ALTER TABLE payments ADD COLUMN entry_id INTEGER REFERENCES financial_entries(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN account_id INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN reconciled_at TEXT;

ALTER TABLE expenses ADD COLUMN entry_id INTEGER REFERENCES financial_entries(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN account_id INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN reconciled_at TEXT;
-- separa dinheiro investido na estrutura de dinheiro gasto para manter a operacao
ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'operacional';

CREATE INDEX IF NOT EXISTS idx_payments_entry ON payments(entry_id);
CREATE INDEX IF NOT EXISTS idx_expenses_entry ON expenses(entry_id);
