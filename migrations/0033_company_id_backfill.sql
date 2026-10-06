-- Pendência #04 (auditoria de pré-produção): os INSERTs que gravavam
-- company_id DEFAULT 1 deixaram linhas legadas apontando para a empresa 1.
-- Este backfill realinha cada linha pelo DONO correto (usuário, cliente,
-- conversa, reserva, inscrição de push).
--
-- Regras de segurança:
--  * cada UPDATE só roda quando a DONO pertence a outra empresa (EXISTS com
--    divergência) — linha que já está certa é no-op absoluto;
--  * linha sem dono (órfã / user_id NULL) permanece intacta;
--  * idempotente: rodar duas vezes não altera nada na segunda.
--
-- Ordem importa: conversa antes de participantes/mensagens, inscrição antes
-- de entregas de push.

-- --------------------------------------------------------- dono = usuario
UPDATE user_notifications SET company_id = (SELECT u.company_id FROM users u WHERE u.id = user_notifications.user_id)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = user_notifications.user_id AND u.company_id <> user_notifications.company_id);

UPDATE notification_preferences SET company_id = (SELECT u.company_id FROM users u WHERE u.id = notification_preferences.user_id)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = notification_preferences.user_id AND u.company_id <> notification_preferences.company_id);

UPDATE push_subscriptions SET company_id = (SELECT u.company_id FROM users u WHERE u.id = push_subscriptions.user_id)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = push_subscriptions.user_id AND u.company_id <> push_subscriptions.company_id);

UPDATE error_logs SET company_id = (SELECT u.company_id FROM users u WHERE u.id = error_logs.user_id)
 WHERE error_logs.user_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = error_logs.user_id AND u.company_id <> error_logs.company_id);

-- --------------------------------------------------------------- audit_logs
-- company_id_ref ja foi preenchido pela fonte correta na migration 0028;
-- a coluna legada company_id passa a espelha-lo (NULL de log de plataforma
-- mantem o DEFAULT 1, coerente com logAction(null)).
UPDATE audit_logs SET company_id = company_id_ref
 WHERE company_id_ref IS NOT NULL AND company_id_ref <> company_id;

-- --------------------------------------------------------------- dono = cliente
UPDATE fidelity_messages SET company_id = (SELECT c.company_id FROM customers c WHERE c.id = fidelity_messages.customer_id)
 WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = fidelity_messages.customer_id AND c.company_id <> fidelity_messages.company_id);

UPDATE fidelity_events SET company_id = (SELECT c.company_id FROM customers c WHERE c.id = fidelity_events.customer_id)
 WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = fidelity_events.customer_id AND c.company_id <> fidelity_events.company_id);

UPDATE fidelity_rewards SET company_id = (SELECT c.company_id FROM customers c WHERE c.id = fidelity_rewards.customer_id)
 WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = fidelity_rewards.customer_id AND c.company_id <> fidelity_rewards.company_id);

-- ------------------------------------------------------- dono = conversa / reserva
UPDATE chat_conversations SET company_id = (SELECT u.company_id FROM users u WHERE u.id = chat_conversations.user_low)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = chat_conversations.user_low AND u.company_id <> chat_conversations.company_id);

UPDATE chat_participants SET company_id = (SELECT c.company_id FROM chat_conversations c WHERE c.id = chat_participants.conversation_id)
 WHERE EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_participants.conversation_id AND c.company_id <> chat_participants.company_id);

UPDATE chat_messages SET company_id = (SELECT c.company_id FROM chat_conversations c WHERE c.id = chat_messages.conversation_id)
 WHERE EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_messages.conversation_id AND c.company_id <> chat_messages.company_id);

UPDATE deposits SET company_id = (SELECT r.company_id FROM reservations r WHERE r.id = deposits.reservation_id)
 WHERE deposits.reservation_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = deposits.reservation_id AND r.company_id <> deposits.company_id);

UPDATE reservation_items SET company_id = (SELECT r.company_id FROM reservations r WHERE r.id = reservation_items.reservation_id)
 WHERE EXISTS (SELECT 1 FROM reservations r WHERE r.id = reservation_items.reservation_id AND r.company_id <> reservation_items.company_id);

UPDATE reservation_item_components SET company_id = (SELECT r.company_id FROM reservations r WHERE r.id = reservation_item_components.reservation_id)
 WHERE EXISTS (SELECT 1 FROM reservations r WHERE r.id = reservation_item_components.reservation_id AND r.company_id <> reservation_item_components.company_id);

-- --------------------------------------------------- dono = inscrição de push
UPDATE push_deliveries SET company_id = (SELECT s.company_id FROM push_subscriptions s WHERE s.id = push_deliveries.subscription_id)
 WHERE EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.id = push_deliveries.subscription_id AND s.company_id <> push_deliveries.company_id);
