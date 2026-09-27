-- Additive operational notifications. No changes to stock, totals or legacy alerts.
ALTER TABLE operations ADD COLUMN assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE operational_roles (key TEXT PRIMARY KEY, label TEXT NOT NULL);
INSERT INTO operational_roles VALUES ('entregador','Entregador'),('retirador','Retirador'),('montador','Montador'),('separador','Separador / estoque'),('financeiro','Financeiro'),('comercial','Comercial'),('gestor','Gestor operacional');
CREATE TABLE user_operational_roles (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL REFERENCES operational_roles(key), PRIMARY KEY(user_id,role));
CREATE TABLE notification_preferences (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('on','off','auto')), PRIMARY KEY(user_id,type));
CREATE TABLE notification_rules (type TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, offsets TEXT NOT NULL DEFAULT '[60,0]', message TEXT NOT NULL DEFAULT '');
INSERT INTO notification_rules(type) VALUES ('entrega'),('retirada'),('montagem'),('desmontagem'),('separacao'),('reserva'),('frete'),('financeiro'),('alteracao'),('cancelamento');
INSERT OR IGNORE INTO settings(key,value) VALUES ('push_enabled','1');
CREATE TABLE activities (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id INTEGER NOT NULL, kind TEXT NOT NULL,
 title TEXT NOT NULL, scheduled_at TEXT NOT NULL, link TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
 assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1, UNIQUE(source,source_id,kind)
);
CREATE INDEX idx_activity_schedule ON activities(status,scheduled_at);
CREATE TABLE notification_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, type TEXT NOT NULL, offset_minutes INTEGER NOT NULL DEFAULT -1,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()), processed INTEGER NOT NULL DEFAULT 0,
 UNIQUE(activity_id,revision,type,offset_minutes)
);
CREATE INDEX idx_notification_events_pending ON notification_events(processed,id);
CREATE TABLE user_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id INTEGER REFERENCES notification_events(id) ON DELETE SET NULL, type TEXT NOT NULL, title TEXT NOT NULL,
 body TEXT NOT NULL, link TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), read_at INTEGER,
 UNIQUE(user_id,event_id)
);
CREATE INDEX idx_user_notifications ON user_notifications(user_id,read_at,id);
CREATE TABLE push_subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
 label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, expiration_time INTEGER,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
 last_success_at INTEGER, last_error TEXT
);
CREATE TABLE push_deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,
 subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, sent_at INTEGER, UNIQUE(notification_id,subscription_id)
);
CREATE INDEX idx_push_delivery_pending ON push_deliveries(status,next_attempt);
CREATE TABLE scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) SELECT 'operations',id,kind,kind || ' #' || id,scheduled_at,'/operacao/' || id,CASE status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,assignee_id,reservation_id FROM operations;
CREATE TRIGGER activity_0_insert AFTER INSERT ON operations BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('operations',NEW.id,NEW.kind,NEW.kind || ' #' || NEW.id,NEW.scheduled_at,'/operacao/' || NEW.id,CASE NEW.status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NEW.assignee_id,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 assignee_id=excluded.assignee_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.assignee_id IS NOT excluded.assignee_id;
END;
CREATE TRIGGER activity_0_update AFTER UPDATE ON operations
WHEN OLD.kind IS NOT NEW.kind OR OLD.scheduled_at IS NOT NEW.scheduled_at OR OLD.status IS NOT NEW.status OR OLD.assignee_id IS NOT NEW.assignee_id BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('operations',NEW.id,NEW.kind,NEW.kind || ' #' || NEW.id,NEW.scheduled_at,'/operacao/' || NEW.id,CASE NEW.status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NEW.assignee_id,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 assignee_id=excluded.assignee_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.assignee_id IS NOT excluded.assignee_id;
END;
CREATE TRIGGER activity_0_delete BEFORE DELETE ON operations BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='operations' AND source_id=OLD.id AND kind=OLD.kind;
END;

INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) SELECT 'reservations',id,'reserva','Reserva ' || number,event_date || 'T' || COALESCE(NULLIF(event_time,''),'08:00'),'/reservas/' || id,CASE WHEN status='cancelada' THEN 'cancelled' WHEN status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,id FROM reservations;
CREATE TRIGGER activity_1_insert AFTER INSERT ON reservations BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('reservations',NEW.id,'reserva','Reserva ' || NEW.number,NEW.event_date || 'T' || COALESCE(NULLIF(NEW.event_time,''),'08:00'),'/reservas/' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_1_update AFTER UPDATE ON reservations
WHEN OLD.event_date IS NOT NEW.event_date OR OLD.event_time IS NOT NEW.event_time OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('reservations',NEW.id,'reserva','Reserva ' || NEW.number,NEW.event_date || 'T' || COALESCE(NULLIF(NEW.event_time,''),'08:00'),'/reservas/' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_1_delete BEFORE DELETE ON reservations BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='reservations' AND source_id=OLD.id AND kind='reserva';
END;

INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) SELECT 'reservations',id,'separacao','Separacao da reserva ' || number,COALESCE(NULLIF(delivery_at,''),event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || id,CASE WHEN status='cancelada' THEN 'cancelled' WHEN status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,id FROM reservations;
CREATE TRIGGER activity_2_insert AFTER INSERT ON reservations BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('reservations',NEW.id,'separacao','Separacao da reserva ' || NEW.number,COALESCE(NULLIF(NEW.delivery_at,''),NEW.event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_2_update AFTER UPDATE ON reservations
WHEN OLD.delivery_at IS NOT NEW.delivery_at OR OLD.event_date IS NOT NEW.event_date OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('reservations',NEW.id,'separacao','Separacao da reserva ' || NEW.number,COALESCE(NULLIF(NEW.delivery_at,''),NEW.event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_2_delete BEFORE DELETE ON reservations BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='reservations' AND source_id=OLD.id AND kind='separacao';
END;

INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) SELECT 'freights',id,'frete','Frete ' || number,date || 'T' || COALESCE(NULLIF(time,''),'08:00'),'/fretes/' || id,CASE status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL FROM freights;
CREATE TRIGGER activity_3_insert AFTER INSERT ON freights BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('freights',NEW.id,'frete','Frete ' || NEW.number,NEW.date || 'T' || COALESCE(NULLIF(NEW.time,''),'08:00'),'/fretes/' || NEW.id,CASE NEW.status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_3_update AFTER UPDATE ON freights
WHEN OLD.date IS NOT NEW.date OR OLD.time IS NOT NEW.time OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('freights',NEW.id,'frete','Frete ' || NEW.number,NEW.date || 'T' || COALESCE(NULLIF(NEW.time,''),'08:00'),'/fretes/' || NEW.id,CASE NEW.status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_3_delete BEFORE DELETE ON freights BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='freights' AND source_id=OLD.id AND kind='frete';
END;

INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) SELECT 'financial_entries',id,'financeiro','Vencimento ' || number,due_date || 'T08:00','/financeiro?aba=' || direction || '&de=' || due_date || '&ate=' || due_date || '#parcela-' || id,CASE status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,reservation_id FROM financial_entries;
CREATE TRIGGER activity_4_insert AFTER INSERT ON financial_entries BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('financial_entries',NEW.id,'financeiro','Vencimento ' || NEW.number,NEW.due_date || 'T08:00','/financeiro?aba=' || NEW.direction || '&de=' || NEW.due_date || '&ate=' || NEW.due_date || '#parcela-' || NEW.id,CASE NEW.status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_4_update AFTER UPDATE ON financial_entries
WHEN OLD.due_date IS NOT NEW.due_date OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES ('financial_entries',NEW.id,'financeiro','Vencimento ' || NEW.number,NEW.due_date || 'T08:00','/financeiro?aba=' || NEW.direction || '&de=' || NEW.due_date || '&ate=' || NEW.due_date || '#parcela-' || NEW.id,CASE NEW.status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_4_delete BEFORE DELETE ON financial_entries BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='financial_entries' AND source_id=OLD.id AND kind='financeiro';
END;

-- Backfill above does not create a flood of "new" alerts. Future reminders still work.
CREATE TRIGGER activity_created AFTER INSERT ON activities BEGIN
 INSERT OR IGNORE INTO notification_events(activity_id,revision,type) VALUES (NEW.id,NEW.revision,'created');
END;
CREATE TRIGGER activity_changed AFTER UPDATE OF revision ON activities WHEN NEW.revision<>OLD.revision BEGIN
 UPDATE push_deliveries SET status='cancelled' WHERE status IN ('pending','sending') AND notification_id IN
 (SELECT n.id FROM user_notifications n JOIN notification_events e ON e.id=n.event_id WHERE e.activity_id=NEW.id AND e.revision<>NEW.revision);
 INSERT OR IGNORE INTO notification_events(activity_id,revision,type) VALUES
 (NEW.id,NEW.revision,CASE WHEN NEW.status='cancelled' THEN 'cancelamento' ELSE 'alteracao' END);
END;

-- Location/content edits invalidate pending reminders without reopening a completed separation.
CREATE TRIGGER reservation_activity_details AFTER UPDATE OF address,district,city,total_cents ON reservations
WHEN OLD.address IS NOT NEW.address OR OLD.district IS NOT NEW.district OR OLD.city IS NOT NEW.city OR OLD.total_cents<>NEW.total_cents BEGIN
 UPDATE activities SET revision=revision+1 WHERE reservation_id=NEW.id;
END;
CREATE TRIGGER freight_activity_details AFTER UPDATE OF origin,destination,cargo,amount_cents ON freights
WHEN OLD.origin IS NOT NEW.origin OR OLD.destination IS NOT NEW.destination OR OLD.cargo IS NOT NEW.cargo OR OLD.amount_cents<>NEW.amount_cents BEGIN
 UPDATE activities SET revision=revision+1 WHERE source='freights' AND source_id=NEW.id;
END;
CREATE TRIGGER financial_activity_details AFTER UPDATE OF amount_cents ON financial_entries
WHEN OLD.amount_cents<>NEW.amount_cents BEGIN
 UPDATE activities SET revision=revision+1 WHERE source='financial_entries' AND source_id=NEW.id;
END;
