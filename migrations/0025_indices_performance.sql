-- Auditoria de performance: indices para as consultas mais quentes do sistema.
-- Nenhum dado e alterado: apenas CREATE INDEX IF NOT EXISTS (operacao segura,
-- sem reescrita de registros, aplicavel em producao com o banco no ar).
--
-- Cada indice existe por uma consulta real medida na auditoria, nao por
-- "boa pratica":

-- 1) audit_logs: as telas de detalhe (reserva, cliente, frete, orcamento,
--    operacao, compra, promocao, produto) leem o historico por entidade com
--    ORDER BY id DESC. O indice antigo idx_audit_entity(entity, entity_id)
--    filtra mas NAO atende a ordenacao, obrigando a ordenar em memoria.
--    Incluir id no fim cobre filtro + ordem de uma vez.
CREATE INDEX IF NOT EXISTS idx_audit_entity_id
  ON audit_logs(entity, entity_id, id);

-- 2) financial_entries: as telas de Financeiro e as telas de parcelas listam
--    sempre por direction com ordenacao por vencimento
--    (WHERE direction = ? ORDER BY due_date). O indice atual
--    idx_entries_direction(direction, status) nao serve de ordem, e
--    idx_entries_due(due_date) nao serve de filtro.
CREATE INDEX IF NOT EXISTS idx_entries_direction_due
  ON financial_entries(direction, due_date);

-- 3) fidelity_rewards: a tela de detalhe da reserva procura
--    WHERE used_reservation_id = ? (leitura por abertura de reserva).
CREATE INDEX IF NOT EXISTS idx_fidelity_rewards_used
  ON fidelity_rewards(used_reservation_id);

-- 4) fidelity_events: saldo do cliente (SUM(delta) WHERE customer_id = ?)
--    calculado a cada abertura do painel do cliente e do portal.
CREATE INDEX IF NOT EXISTS idx_fidelity_events_customer_only
  ON fidelity_events(customer_id);

-- 5) products: estoque, disponibilidade e alertas filtram kind + active
--    (WHERE active = 1 AND kind <> 'kit'). Indice parcial: so linhas ativas
--    entram, mantendo o indice pequeno.
CREATE INDEX IF NOT EXISTS idx_products_active_kind
  ON products(active, kind) WHERE active = 1;

-- 6) deposits: Financeiro soma caucoes retidas
--    (SUM WHERE status IN ('retida_parcial','retida_integral')) a cada abertura.
CREATE INDEX IF NOT EXISTS idx_deposits_status
  ON deposits(status);

-- 7) operations por veiculo: formularios de operacao listam os veiculos
--    ativos (WHERE active = 1 ORDER BY name).
CREATE INDEX IF NOT EXISTS idx_vehicles_active
  ON vehicles(active, name) WHERE active = 1;
