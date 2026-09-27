-- Resolucao de danos: baixa definitiva e manutencao com rastreabilidade.
--
-- Antes desta migration, reportDamage apenas gravava a ocorrencia
-- (damage_reports) e retinha a caucao: nenhuma unidade saia do estoque e a
-- disponibilidade continuava contando o item quebrado como disponivel.
--
-- A partir daqui o registro de dano ganha um ciclo de vida:
--
--   registrada    -> dano documentado, estoque intocado
--   baixada       -> perda definitiva: as unidades saem de total_qty
--   em_manutencao -> consertavel: entram em maintenance_qty (indisponiveis)
--   consertada    -> retornaram de manutencao ao disponivel
--   estornada     -> a baixa foi desfeita por movimentacao inversa
--
-- O estoque NUNCA e tocado sozinho: toda baixa/estorno grava a sua linha em
-- stock_movements (livro unico, o mesmo das compras), com vinculo para o dano
-- e para a reserva de origem. A coluna resolution_status impede dupla baixa:
-- so e possivel resolver a partir de registrada/estornada/consertada, e o
-- estorno devolve por movimentacao inversa, nunca por DELETE.
--
-- O trigger abaixo faz a resolucao participar do CAS do stock_revision
-- (migration 0012): se uma reserva mudar entre a verificacao e a gravacao do
-- dano, o commitStockBatch falha e nada e aplicado pela metade.

ALTER TABLE damage_reports ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'registrada'
  CHECK (resolution_status IN ('registrada','baixada','em_manutencao','consertada','estornada'));
ALTER TABLE damage_reports ADD COLUMN resolution_action TEXT;
  -- destino escolhido: 'baixa' | 'manutencao' | NULL (ainda nao resolvido)
ALTER TABLE damage_reports ADD COLUMN resolved_at TEXT;
ALTER TABLE damage_reports ADD COLUMN resolved_by INTEGER REFERENCES users(id);
ALTER TABLE damage_reports ADD COLUMN resolution_notes TEXT;

-- manutencao aberta a partir deste dano (recupera o par aberto/fechado no
-- estorno e na conclusao do conserto)
ALTER TABLE damage_reports ADD COLUMN maintenance_id INTEGER REFERENCES maintenance(id) ON DELETE SET NULL;

-- manutencoes abertas a partir de um dano, para o estorno encontrar o par
ALTER TABLE maintenance ADD COLUMN damage_report_id INTEGER REFERENCES damage_reports(id) ON DELETE SET NULL;

-- Rastreabilidade do livro: movimentos de dano apontam para a ocorrencia e
-- para a reserva. Nulos nao afetam os movimentos de compra ja existentes.
ALTER TABLE stock_movements ADD COLUMN damage_report_id INTEGER REFERENCES damage_reports(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stockmov_damage ON stock_movements(damage_report_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_reservation ON stock_movements(reservation_id);
CREATE INDEX IF NOT EXISTS idx_damages_resolution ON damage_reports(resolution_status);
CREATE INDEX IF NOT EXISTS idx_maintenance_damage ON maintenance(damage_report_id);

CREATE TRIGGER stock_revision_damage_reports_resolution
AFTER UPDATE ON damage_reports
WHEN COALESCE(new.resolution_status,'') IS NOT COALESCE(old.resolution_status,'')
BEGIN
  UPDATE stock_revision SET revision = revision + 1 WHERE id = 1;
END;
