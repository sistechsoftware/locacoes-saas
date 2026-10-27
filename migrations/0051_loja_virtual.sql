-- ============================================================================
-- 0051 — LOJA VIRTUAL POR EMPRESA (canal público de solicitações)
-- ----------------------------------------------------------------------------
-- Princípios desta migração:
--  * NADA de dados existente é alterado ou apagado: só tabelas NOVAS e duas
--    colunas de vínculo com DEFAULT neutro (NULL) — reservas/orçamentos já
--    gravados continuam idênticos e sem origem de loja (NULL = não veio daqui);
--  * NÃO existe estoque, disponibilidade ou frete próprios: a loja lê as
--    tabelas operacionais já existentes (products, reservations, stock_*) e,
--    quando uma solicitação vira reserva, passa pelo MESMO caminho de escrita
--    (stock-write.ts) do painel;
--  * um pedido da loja é a FONTE comercial da solicitação (itens e valores
--    congelados no momento do envio) e aponta para a reserva/orçamento que o
--    painel venha a criar — o histórico do que foi proposto ao cliente não muda
--    se o preço do produto mudar depois;
--  * todo acesso público resolve o tenant por company_stores.slug (UNIQUE) e
--    NUNCA por identificador enviado pelo navegador;
--  * o comprovante de pagamento vive em `files` (mesma infraestrutura do
--    sistema) e só é exposto por uma linha em store_receipts, consultável
--    pela empresa e pelo token de acompanhamento do próprio pedido.
-- ============================================================================

PRAGMA defer_foreign_keys = true;

-- ----------------------------------------------------------------------------
-- 1) CONFIGURAÇÃO DA LOJA (1:1 com a empresa)
-- ----------------------------------------------------------------------------
-- status:
--   'desativada' — a empresa ainda não publicou (ou desligou) a loja;
--   'rascunho'   — configurando, invisível para o público;
--   'publicada'  — acessível pelo slug.
-- mode: 'orcamento' (só orçamento) | 'manual' (aprovação manual) |
--       'automatica' (aprovação automática com regras).
-- ----------------------------------------------------------------------------
CREATE TABLE company_stores (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'desativada'
                      CHECK (status IN ('desativada','rascunho','publicada')),
  paused              INTEGER NOT NULL DEFAULT 0,
  pause_message       TEXT,

  -- identidade pública (independente dos dados internos da conta)
  display_name        TEXT NOT NULL DEFAULT '',
  logo_url            TEXT,
  banner_url          TEXT,
  description         TEXT NOT NULL DEFAULT '',
  presentation        TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  whatsapp            TEXT NOT NULL DEFAULT '',
  address             TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL DEFAULT '',
  region              TEXT NOT NULL DEFAULT '',
  hours               TEXT NOT NULL DEFAULT '',
  instagram           TEXT NOT NULL DEFAULT '',
  extra_info          TEXT NOT NULL DEFAULT '',

  -- identidade visual (paleta da loja; NÃO altera o painel da empresa)
  theme               TEXT NOT NULL DEFAULT 'padrao',
  color_primary       TEXT NOT NULL DEFAULT '',
  color_secondary     TEXT NOT NULL DEFAULT '',
  color_accent        TEXT NOT NULL DEFAULT '',
  color_background    TEXT NOT NULL DEFAULT '',
  color_text          TEXT NOT NULL DEFAULT '',
  button_style        TEXT NOT NULL DEFAULT 'arredondado'
                      CHECK (button_style IN ('arredondado','quadrado')),

  -- layout / seções
  show_banner         INTEGER NOT NULL DEFAULT 1,
  show_about          INTEGER NOT NULL DEFAULT 1,
  show_delivery       INTEGER NOT NULL DEFAULT 1,
  show_faq            INTEGER NOT NULL DEFAULT 1,
  show_contact        INTEGER NOT NULL DEFAULT 1,
  about_text          TEXT NOT NULL DEFAULT '',
  delivery_text       TEXT NOT NULL DEFAULT '',
  faq_json            TEXT NOT NULL DEFAULT '[]',
  notice_text         TEXT NOT NULL DEFAULT '',

  -- SEO / compartilhamento
  seo_title           TEXT NOT NULL DEFAULT '',
  seo_description     TEXT NOT NULL DEFAULT '',
  seo_image_url       TEXT,

  -- regras comerciais
  mode                TEXT NOT NULL DEFAULT 'manual'
                      CHECK (mode IN ('orcamento','manual','automatica')),
  hide_prices         INTEGER NOT NULL DEFAULT 0,
  min_lead_days       INTEGER NOT NULL DEFAULT 0,
  max_days_ahead      INTEGER NOT NULL DEFAULT 0,   -- 0 = sem limite
  min_order_cents     INTEGER NOT NULL DEFAULT 0,
  offer_delivery      INTEGER NOT NULL DEFAULT 1,
  offer_pickup        INTEGER NOT NULL DEFAULT 1,
  freight_type        TEXT NOT NULL DEFAULT 'locacao'
                      CHECK (freight_type IN ('comum','locacao')),
  freight_pending_ok  INTEGER NOT NULL DEFAULT 1,   -- aceitar envio com frete a confirmar
  signal_percent      INTEGER NOT NULL DEFAULT 0,
  payment_deadline_h  INTEGER NOT NULL DEFAULT 48,
  require_terms       INTEGER NOT NULL DEFAULT 0,
  terms_text          TEXT NOT NULL DEFAULT '',
  cancellation_text   TEXT NOT NULL DEFAULT '',
  privacy_text        TEXT NOT NULL DEFAULT '',
  success_message     TEXT NOT NULL DEFAULT '',

  -- Pix (exibição pública só com pix_enabled = 1)
  pix_enabled         INTEGER NOT NULL DEFAULT 0,
  pix_key             TEXT NOT NULL DEFAULT '',
  pix_holder          TEXT NOT NULL DEFAULT '',
  pix_city            TEXT NOT NULL DEFAULT '',
  pix_institution     TEXT NOT NULL DEFAULT '',
  pix_instructions    TEXT NOT NULL DEFAULT '',

  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ----------------------------------------------------------------------------
-- 2) PRODUTOS PUBLICADOS (seleção comercial por produto)
-- ----------------------------------------------------------------------------
-- public_price_cents NULL = a loja usa o preço operacional do produto (e o
-- sistema de sincronização configurado na empresa vale); com valor, é um
-- preço COMERCIAL próprio da loja — nenhuma das duas escritas toca no
-- rent_price_cents do cadastro.
-- ----------------------------------------------------------------------------
CREATE TABLE store_products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  published          INTEGER NOT NULL DEFAULT 0,
  public_price_cents INTEGER,
  public_name        TEXT,
  public_description TEXT,
  photo_url          TEXT,
  featured           INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  max_qty            INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (company_id, product_id)
);
CREATE INDEX idx_store_products_public ON store_products(company_id, published, sort_order);

-- ----------------------------------------------------------------------------
-- 3) PEDIDOS RECEBIDOS PELA LOJA
-- ----------------------------------------------------------------------------
-- kind    — o que o cliente pediu ('orcamento' | 'reserva');
-- status  — fluxo comercial da solicitação:
--   'aguardando_analise'             — enviado, aguarda a locadora;
--   'aprovada_aguardando_pagamento'  — aprovada, sinal/total ainda não ok;
--   'confirmada'                     — reserva confirmada / proposta aceita;
--   'recusada' | 'cancelada' | 'expirada'.
-- payment_status — estado financeiro separado do estado comercial.
-- tracking_hash  — SHA-256 do token de acompanhamento (o token claro só sai
--                   na resposta que cria o pedido; o banco guarda o hash).
-- ----------------------------------------------------------------------------
CREATE TABLE store_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number            TEXT NOT NULL,
  tracking_hash     TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('orcamento','reserva')),
  status            TEXT NOT NULL DEFAULT 'aguardando_analise'
                    CHECK (status IN ('aguardando_analise','aprovada_aguardando_pagamento','confirmada','recusada','cancelada','expirada')),
  payment_status    TEXT NOT NULL DEFAULT 'nao_informado'
                    CHECK (payment_status IN ('nao_informado','aguardando','comprovante_enviado','em_analise','confirmado','recusado','expirado')),

  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT,
  customer_email    TEXT,
  customer_doc      TEXT,

  event_date        TEXT NOT NULL,
  event_time        TEXT,
  delivery_at       TEXT,
  pickup_at         TEXT,
  needs_delivery    INTEGER NOT NULL DEFAULT 1,
  address           TEXT,
  district          TEXT,
  city              TEXT,
  zip               TEXT,
  notes             TEXT,

  freight_cents     INTEGER NOT NULL DEFAULT 0,
  freight_status    TEXT NOT NULL DEFAULT 'nao_calculado'
                    CHECK (freight_status IN ('nao_calculado','calculado','pendente','isento')),
  items_cents       INTEGER NOT NULL DEFAULT 0,
  total_cents       INTEGER NOT NULL DEFAULT 0,
  signal_cents      INTEGER NOT NULL DEFAULT 0,
  payment_deadline_at TEXT,
  terms_accepted    INTEGER NOT NULL DEFAULT 0,

  reservation_id    INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  quote_id          INTEGER REFERENCES quotes(id) ON DELETE SET NULL,

  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_store_orders_company ON store_orders(company_id, created_at DESC);
CREATE INDEX idx_store_orders_status ON store_orders(company_id, status);
-- Número de pedido é sequencial POR EMPRESA: o UNIQUE resolve corrida de
-- duas submissões simultâneas calculando o mesmo próximo número (retry).
CREATE UNIQUE INDEX idx_store_orders_number ON store_orders(company_id, number);

-- ----------------------------------------------------------------------------
-- 4) ITENS DO PEDIDO (histórico congelado da proposta)
-- ----------------------------------------------------------------------------
CREATE TABLE store_order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  store_order_id   INTEGER NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  name             TEXT NOT NULL,
  qty              INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  period_qty       INTEGER NOT NULL DEFAULT 1,
  pricing_mode     TEXT NOT NULL DEFAULT 'fixo',
  subtotal_cents   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_store_order_items_order ON store_order_items(store_order_id);

-- ----------------------------------------------------------------------------
-- 5) HISTÓRICO DAS ALTERAÇÕES RELEVANTES
-- ----------------------------------------------------------------------------
CREATE TABLE store_order_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_order_id  INTEGER NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  description     TEXT NOT NULL,
  actor           TEXT NOT NULL DEFAULT 'cliente',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_store_order_events ON store_order_events(store_order_id, id);

-- ----------------------------------------------------------------------------
-- 6) COMPROVANTES DE PAGAMENTO
-- ----------------------------------------------------------------------------
-- Os bytes ficam na tabela `files` (infraestrutura existente); esta linha é o
-- vínculo autorizado com o pedido. Sem ela, um id de arquivo não é servido a
-- ninguém publicamente — o arquivo da loja só sai por rota protegida que
-- confere ou a empresa dona do pedido ou o token de acompanhamento dele.
-- ----------------------------------------------------------------------------
CREATE TABLE store_receipts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_order_id  INTEGER NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_id         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'aguardando'
                  CHECK (status IN ('aguardando','confirmado','recusado')),
  notes           TEXT,
  submitted_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  reviewed_at     TEXT,
  reviewed_by     INTEGER REFERENCES users(id)
);
CREATE INDEX idx_store_receipts_order ON store_receipts(store_order_id, id);

-- ----------------------------------------------------------------------------
-- 7) ORIGEM NO PAINEL: a reserva/orçamento nascido da loja é identificável
--    (DEFAULT NULL = todas as reservas existentes seguem sem origem).
-- ----------------------------------------------------------------------------
ALTER TABLE reservations ADD COLUMN store_order_id INTEGER REFERENCES store_orders(id) ON DELETE SET NULL;
ALTER TABLE quotes       ADD COLUMN store_order_id INTEGER REFERENCES store_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_res_store_order ON reservations(store_order_id);
