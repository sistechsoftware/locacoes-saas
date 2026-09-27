-- Chat entre usuarios do sistema.
--
-- Modelo escolhido: conversas sempre de 1:1 (par privado de usuarios).
-- A conversa e identificada pelo par ordenado (user_low, user_high), criada
-- sob demanda na primeira mensagem: nao existe "conversa vazia".
--
-- Leitura por cursor (last_read_message_id) em vez de flag por mensagem: uma
-- escrita unica ao abrir a conversa, e o contador de nao lidas sai de um
-- COUNT indexado. A pagina de conversa carrega as mensagens mais recentes e
-- pagina para tras com WHERE id < cursor.
--
-- Arquivar e por participante (chat_participants.archived_at): excluir
-- conversa de um lado nunca apaga o historico do outro. Exclusao logica de
-- mensagem (deleted_at) preserva o historico do destinatario que ja leu.
--
-- Os anexos/audios usam a tabela files existente (blob no D1), mas o acesso
-- sai por /api/chat/arquivo/<id> com checagem de participacao — a rota
-- publica /api/arquivo/<id> NAO serve arquivos de chat.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_low   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (user_low, user_high),
  CHECK (user_low < user_high)
);

CREATE TABLE IF NOT EXISTS chat_participants (
  conversation_id       INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id  INTEGER NOT NULL DEFAULT 0,
  archived_at           TEXT,
  -- id da ultima mensagem vista no momento do arquivamento: "arquivar ate
  -- aqui", sem corrida com o segundo da mensagem nova
  archive_before        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
-- Lista de conversas: pega os participantes por user_id, ordena pelo recibo
CREATE INDEX IF NOT EXISTS idx_chat_part_user ON chat_participants(user_id, last_read_message_id);
CREATE INDEX IF NOT EXISTS idx_chat_part_conv ON chat_participants(conversation_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id),
  body            TEXT,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','audio','file','image')),
  file_id         TEXT REFERENCES files(id) ON DELETE SET NULL,
  file_name       TEXT,
  file_mime       TEXT,
  file_size       INTEGER,
  audio_seconds   INTEGER,
  duration_ms     INTEGER,
  read_at         TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- (conversation_id, id) tambem serve a varredura reversa (id DESC): o SQLite
-- percorre o mesmo indice de tras para frente
CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id, id);

-- Fila existente de push/central: novo tipo 'chat' com lembrete desligado,
-- na cadencia padrao do sistema (apos o cron de 1 minuto).
INSERT INTO notification_rules (type, enabled, offsets, message)
VALUES ('chat', 1, '[0]', '')
ON CONFLICT(type) DO NOTHING;
