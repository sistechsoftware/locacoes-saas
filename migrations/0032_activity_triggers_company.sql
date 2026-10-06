-- Pendência #04 (auditoria de pré-produção): as triggers de activities da
-- migration 0006 gravavam company_id DEFAULT 1 — toda operação/reserva/frete/
-- lançamento financeiro de QUALQUER tenant nascia apontando para a empresa 1.
--
-- Agora o company_id vem da FONTE (NEW.company_id da linha que dispara),
-- inclusive no ramo ON CONFLICT (auto-correção de linha já existente). Os
-- triggers de DELETE apenas atualizam status e permanecem como estão; os de
-- detalhe (reservation_activity_details etc.) apenas bumpam revision.
--
-- Backfill no fim do arquivo: activities e notification_events já gravados
-- são realinhados pela MESMA fonte, somente quando divergem (no-op para quem
-- já está certo; linha órfã sem fonte permanece intacta).

DROP TRIGGER IF EXISTS activity_0_insert;
CREATE TRIGGER activity_0_insert AFTER INSERT ON operations BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('operations',NEW.id,NEW.kind,NEW.kind || ' #' || NEW.id,NEW.scheduled_at,'/operacao/' || NEW.id,CASE NEW.status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NEW.assignee_id,NEW.reservation_id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 assignee_id=excluded.assignee_id,company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.assignee_id IS NOT excluded.assignee_id OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_0_update;
CREATE TRIGGER activity_0_update AFTER UPDATE ON operations
WHEN OLD.kind IS NOT NEW.kind OR OLD.scheduled_at IS NOT NEW.scheduled_at OR OLD.status IS NOT NEW.status OR OLD.assignee_id IS NOT NEW.assignee_id BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('operations',NEW.id,NEW.kind,NEW.kind || ' #' || NEW.id,NEW.scheduled_at,'/operacao/' || NEW.id,CASE NEW.status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NEW.assignee_id,NEW.reservation_id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 assignee_id=excluded.assignee_id,company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.assignee_id IS NOT excluded.assignee_id OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_1_insert;
CREATE TRIGGER activity_1_insert AFTER INSERT ON reservations BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('reservations',NEW.id,'reserva','Reserva ' || NEW.number,NEW.event_date || 'T' || COALESCE(NULLIF(NEW.event_time,''),'08:00'),'/reservas/' || NEW.id,CASE NEW.status WHEN 'cancelada' THEN 'cancelled' WHEN NEW.status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_1_update;
CREATE TRIGGER activity_1_update AFTER UPDATE ON reservations
WHEN OLD.event_date IS NOT NEW.event_date OR OLD.event_time IS NOT NEW.event_time OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('reservations',NEW.id,'reserva','Reserva ' || NEW.number,NEW.event_date || 'T' || COALESCE(NULLIF(NEW.event_time,''),'08:00'),'/reservas/' || NEW.id,CASE NEW.status WHEN 'cancelada' THEN 'cancelled' WHEN NEW.status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_2_insert;
CREATE TRIGGER activity_2_insert AFTER INSERT ON reservations BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('reservations',NEW.id,'separacao','Separacao da reserva ' || NEW.number,COALESCE(NULLIF(NEW.delivery_at,''),NEW.event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || NEW.id,CASE NEW.status WHEN 'cancelada' THEN 'cancelled' WHEN NEW.status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_2_update;
CREATE TRIGGER activity_2_update AFTER UPDATE ON reservations
WHEN OLD.delivery_at IS NOT NEW.delivery_at OR OLD.event_date IS NOT NEW.event_date OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('reservations',NEW.id,'separacao','Separacao da reserva ' || NEW.number,COALESCE(NULLIF(NEW.delivery_at,''),NEW.event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || NEW.id,CASE NEW.status WHEN 'cancelada' THEN 'cancelled' WHEN NEW.status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_3_insert;
CREATE TRIGGER activity_3_insert AFTER INSERT ON freights BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('freights',NEW.id,'frete','Frete ' || NEW.number,NEW.date || 'T' || COALESCE(NULLIF(NEW.time,''),'08:00'),'/fretes/' || NEW.id,CASE NEW.status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_3_update;
CREATE TRIGGER activity_3_update AFTER UPDATE ON freights
WHEN OLD.date IS NOT NEW.date OR OLD.time IS NOT NEW.time OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('freights',NEW.id,'frete','Frete ' || NEW.number,NEW.date || 'T' || COALESCE(NULLIF(NEW.time,''),'08:00'),'/fretes/' || NEW.id,CASE NEW.status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_4_insert;
CREATE TRIGGER activity_4_insert AFTER INSERT ON financial_entries BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('financial_entries',NEW.id,'financeiro','Vencimento ' || NEW.number,NEW.due_date || 'T08:00','/financeiro?aba=' || NEW.direction || '&de=' || NEW.due_date || '&ate=' || NEW.due_date || '#parcela-' || NEW.id,CASE NEW.status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,NEW.reservation_id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

DROP TRIGGER IF EXISTS activity_4_update;
CREATE TRIGGER activity_4_update AFTER UPDATE ON financial_entries
WHEN OLD.due_date IS NOT NEW.due_date OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id,company_id) VALUES ('financial_entries',NEW.id,'financeiro','Vencimento ' || NEW.number,NEW.due_date || 'T08:00','/financeiro?aba=' || NEW.direction || '&de=' || NEW.due_date || '&ate=' || NEW.due_date || '#parcela-' || NEW.id,CASE NEW.status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,NEW.reservation_id,NEW.company_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 company_id=excluded.company_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.company_id<>excluded.company_id;
END;

-- notification_events nasce da activity: herda o MESMO escopo (antes gravava
-- company_id DEFAULT 1 via trigger e quebrava a leitura por tenant do push).
DROP TRIGGER IF EXISTS activity_created;
CREATE TRIGGER activity_created AFTER INSERT ON activities BEGIN
 INSERT OR IGNORE INTO notification_events(company_id,activity_id,revision,type) VALUES (NEW.company_id,NEW.id,NEW.revision,'created');
END;

DROP TRIGGER IF EXISTS activity_changed;
CREATE TRIGGER activity_changed AFTER UPDATE OF revision ON activities WHEN NEW.revision<>OLD.revision BEGIN
 UPDATE push_deliveries SET status='cancelled' WHERE status IN ('pending','sending') AND notification_id IN
 (SELECT n.id FROM user_notifications n JOIN notification_events e ON e.id=n.event_id WHERE e.activity_id=NEW.id AND e.revision<>NEW.revision);
 INSERT OR IGNORE INTO notification_events(company_id,activity_id,revision,type) VALUES
 (NEW.company_id,NEW.id,NEW.revision,CASE WHEN NEW.status='cancelled' THEN 'cancelamento' ELSE 'alteracao' END);
END;

-- =====================================================================
-- Backfill: realinha o já gravado pela MESMA fonte das triggers.
-- Cada UPDATE só toca linha cuja empresa diverge da fonte (no-op do resto).
-- =====================================================================

UPDATE activities SET company_id = (SELECT r.company_id FROM reservations r WHERE r.id = activities.source_id)
 WHERE source = 'reservations'
   AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = activities.source_id AND r.company_id <> activities.company_id);

UPDATE activities SET company_id = (SELECT o.company_id FROM operations o WHERE o.id = activities.source_id)
 WHERE source = 'operations'
   AND EXISTS (SELECT 1 FROM operations o WHERE o.id = activities.source_id AND o.company_id <> activities.company_id);

UPDATE activities SET company_id = (SELECT f.company_id FROM freights f WHERE f.id = activities.source_id)
 WHERE source = 'freights'
   AND EXISTS (SELECT 1 FROM freights f WHERE f.id = activities.source_id AND f.company_id <> activities.company_id);

UPDATE activities SET company_id = (SELECT fe.company_id FROM financial_entries fe WHERE fe.id = activities.source_id)
 WHERE source = 'financial_entries'
   AND EXISTS (SELECT 1 FROM financial_entries fe WHERE fe.id = activities.source_id AND fe.company_id <> activities.company_id);

UPDATE notification_events SET company_id = (SELECT a.company_id FROM activities a WHERE a.id = notification_events.activity_id)
 WHERE EXISTS (SELECT 1 FROM activities a WHERE a.id = notification_events.activity_id AND a.company_id <> notification_events.company_id);
