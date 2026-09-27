/**
 * Chat entre usuarios, com o SQL real (SQLite + migrations).
 *
 * Cobre: criacao de conversa sob demanda, envio de texto/audio/arquivo,
 * permissao de participacao (leitura e anexo), cursor de leitura e contadores,
 * notificacao na central existente (user_notifications), exclusao logica,
 * arquivamento e envio para usuario inativo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1";
import { all, insert, one, scalar } from "../src/lib/db";
import {
  ChatError,
  archiveConversation,
  contactableUsers,
  deleteMessage,
  ensureConversation,
  isParticipant,
  lastReadOf,
  listConversations,
  listMessages,
  markRead,
  sendMessage,
  stateSince,
  unreadConversations,
  unreadMessages,
} from "../src/lib/chat";
import type { SessionUser } from "../src/lib/auth";

let seq = 0;

function usuario(role: "admin" | "operador" = "operador"): SessionUser & { id: number } {
  return { id: ++seq, name: `User ${seq}`, username: `u${seq}`, role, avatar_url: null };
}

async function gravarUsuario(u: SessionUser) {
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (?,?,?,'x',?)`, [
    u.id,
    u.name,
    u.username,
    u.role,
  ]);
}

function arquivo(nome: string, tipo: string, conteudo = new Uint8Array([1, 2, 3])) {
  return new File([new Uint8Array(conteudo)], nome, { type: tipo });
}

beforeEach(() => {
  createTestDb();
  seq = 0;
});
afterEach(() => resetTestDb);

describe("conversa 1:1", () => {
  it("cria a conversa sob demanda na primeira mensagem e reutiliza depois", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);

    const c1 = await ensureConversation(a.id, b.id);
    const c2 = await ensureConversation(b.id, a.id);
    assert.equal(c1, c2, "mesmo par, mesma conversa (ordem invertida incluida)");
    assert.equal(await scalar(`SELECT COUNT(*) FROM chat_conversations`), 1);
    assert.equal(await scalar(`SELECT COUNT(*) FROM chat_participants`), 2);
  });

  it("recusa conversa com o proprio usuario ou com usuario inexistente/inativo", async () => {
    const a = usuario();
    await gravarUsuario(a);
    await assert.rejects(() => ensureConversation(a.id, a.id), ChatError);
    await assert.rejects(() => ensureConversation(a.id, 999), ChatError);
    const inativo = usuario();
    await gravarUsuario(inativo);
    await all(`UPDATE users SET active = 0 WHERE id = ${inativo.id}`);
    await assert.rejects(() => ensureConversation(a.id, inativo.id), ChatError);
  });

  it("contatos nao incluem o proprio usuario nem inativos", async () => {
    const a = usuario();
    const b = usuario();
    const inativo = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await gravarUsuario(inativo);
    await all(`UPDATE users SET active = 0 WHERE id = ${inativo.id}`);
    const lista = await contactableUsers(a.id);
    assert.deepEqual(lista.map((x) => x.id), [b.id]);
  });
});

describe("envio e permissao", () => {
  it("texto simples vira mensagem com remetente, conversa e carimbo", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const msgs = await sendMessage(a, { otherUserId: b.id, body: "Ola, tudo bem?" });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].kind, "text");
    assert.equal(msgs[0].body, "Ola, tudo bem?");
    const noBanco = await one<any>(`SELECT * FROM chat_messages WHERE id = ?`, [msgs[0].id]);
    assert.ok(noBanco.created_at, "carimbo de data/hora do banco");
    assert.ok(!msgs[0].file_id);
  });

  it("arquivo de imagem vira mensagem image com nome, mime e tamanho", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const f = arquivo("evento.png", "image/png", new Uint8Array([137, 80, 78, 71]));
    const msgs = await sendMessage(a, { otherUserId: b.id, body: null, files: [f] });
    assert.equal(msgs[0].kind, "image");
    assert.equal(msgs[0].file_name, "evento.png");
    assert.equal(msgs[0].file_mime, "image/png");
    assert.equal(msgs[0].file_size, 4);
    const noBanco = await one<any>(`SELECT file_id FROM chat_messages WHERE id = ?`, [msgs[0].id]);
    const blob = await one<any>(`SELECT mime, size FROM files WHERE id = ?`, [noBanco.file_id]);
    assert.equal(blob.mime, "image/png");
    assert.equal(blob.size, 4);
  });

  it("audio grava tipo audio e duracao informada", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const f = arquivo("audio.webm", "audio/webm");
    const msgs = await sendMessage(a, { otherUserId: b.id, audio: f, audioSeconds: 7, clientDurationMs: 7400 });
    assert.equal(msgs[0].kind, "audio");
    assert.equal(msgs[0].audio_seconds, 7);
    assert.equal(msgs[0].duration_ms, 7400);
  });

  it("recusa executavel disfarcado e tipo nao listado", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await assert.rejects(
      () => sendMessage(a, { otherUserId: b.id, files: [arquivo("virus.exe", "application/octet-stream")] }),
      /não é permitido|Formato não suportado/,
    );
    await assert.rejects(
      () => sendMessage(a, { otherUserId: b.id, files: [arquivo("dados.xml", "application/xml")] }),
      /Formato não suportado/,
    );
  });

  it("recusa mensagem sem conteudo nenhum", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await assert.rejects(() => sendMessage(a, { otherUserId: b.id, body: "   " }), ChatError);
  });

  it("quem nao participa nao le as mensagens", async () => {
    const a = usuario();
    const b = usuario();
    const intruso = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await gravarUsuario(intruso);
    const [msg] = await sendMessage(a, { otherUserId: b.id, body: "secreto" });
    assert.ok(await isParticipant(msg.conversation_id, b.id));
    assert.ok(!(await isParticipant(msg.conversation_id, intruso.id)));
    await assert.rejects(() => listMessages(intruso.id, msg.conversation_id), ChatError);
    await assert.rejects(() => stateSince(intruso.id, msg.conversation_id, 0), ChatError);
    await assert.rejects(() => markRead(intruso.id, msg.conversation_id), ChatError);
  });

  it("conversa inexistente e recusada em todas as operacoes", async () => {
    const a = usuario();
    await gravarUsuario(a);
    await assert.rejects(() => listMessages(a.id, 4242), ChatError);
  });
});

describe("leitura e contadores", () => {
  it("nao lidas contam por participante e zera ao marcar", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    for (const texto of ["1", "2", "3"]) await sendMessage(a, { otherUserId: b.id, body: texto });

    assert.equal(await unreadMessages(b.id), 3);
    assert.equal(await unreadConversations(b.id), 1);
    assert.equal(await unreadMessages(a.id), 0, "quem enviou nao conta nao lida");

    const lista = await listConversations(b.id);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].unread, 3);
    assert.equal(lista[0].other_id, a.id);
    assert.equal(lista[0].last_body, "3");

    await markRead(b.id, lista[0].conversation_id);
    assert.equal(await unreadMessages(b.id), 0);
    assert.equal(await lastReadOf(lista[0].conversation_id, b.id), 3);
    assert.equal(await unreadMessages(a.id), 0);
  });

  it("ordenacao da lista segue a mensagem mais recente", async () => {
    const a = usuario();
    const [b, c] = [usuario(), usuario()];
    await gravarUsuario(a);
    await gravarUsuario(b);
    await gravarUsuario(c);
    await sendMessage(a, { otherUserId: b.id, body: "para b" });
    await sendMessage(a, { otherUserId: c.id, body: "para c" });
    await sendMessage(c, { otherUserId: a.id, body: "resposta de c" });

    const lista = await listConversations(a.id);
    assert.equal(lista[0].other_id, c.id, "a conversa com mensagem mais nova vem primeiro");
    assert.equal(lista[0].last_sender_id, c.id);
    assert.equal(lista[1].other_id, b.id);
  });

  it("notificacao interna e criada para o destinatario, nao para o remetente", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await sendMessage(a, { otherUserId: b.id, body: "oi b" });
    const avisos = await all<any>(`SELECT * FROM user_notifications`);
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].user_id, b.id);
    assert.equal(avisos[0].type, "chat");
    assert.equal(avisos[0].title, `Nova mensagem de ${a.name}`);
    assert.equal(avisos[0].body, "oi b", "preview do texto no corpo");
    assert.equal(avisos[0].link, `/chat?c=${(await one<any>(`SELECT id FROM chat_conversations`)).id}`);
  });

  it("notificacao de audio/arquivo nao vaza o conteudo", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await sendMessage(a, { otherUserId: b.id, audio: arquivo("fala.webm", "audio/webm"), audioSeconds: 3 });
    const aviso = await one<any>(`SELECT * FROM user_notifications`);
    assert.equal(aviso.body, "Mensagem de audio");
  });

  it("marcar leitura consome as notificacoes internas da conversa", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    await sendMessage(a, { otherUserId: b.id, body: "oi" });
    const conv = (await one<any>(`SELECT id FROM chat_conversations`)).id;
    await markRead(b.id, conv);
    const pendente = await scalar(`SELECT COUNT(*) FROM user_notifications WHERE read_at IS NULL`);
    assert.equal(pendente, 0);
  });

  it("estado incremental devolve so as mensagens novas e contadores", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const [m1] = await sendMessage(a, { otherUserId: b.id, body: "primeira" });
    const [m2] = await sendMessage(b, { body: "segunda", conversationId: m1.conversation_id });
    const st = await stateSince(b.id, m1.conversation_id, m1.id);
    assert.equal(st.messages.length, 1);
    assert.equal(st.messages[0].id, m2.id);
    assert.equal(st.unread, 1);
    assert.equal(st.readCursor >= 0, true);
  });
});

describe("exclusao, arquivamento e paginacao", () => {
  it("exclusao logica: some o texto, fica o registro, e so o remetente pode", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const [msg] = await sendMessage(a, { otherUserId: b.id, body: "apagar" });
    await assert.rejects(() => deleteMessage(b.id, msg.id), /Somente o remetente/);
    await deleteMessage(a.id, msg.id);
    const depois = await one<any>(`SELECT * FROM chat_messages WHERE id = ?`, [msg.id]);
    assert.ok(depois, "registro permanece");
    assert.ok(depois.deleted_at, "marcado como excluido");
    assert.equal(depois.body, null);
    const visao = await listMessages(b.id, msg.conversation_id);
    assert.equal(visao.messages[0].deleted_at != null, true);
  });

  it("arquivar esconde a conversa; mensagem nova traz de volta so para quem arquivou", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const [msg] = await sendMessage(a, { otherUserId: b.id, body: "oi" });
    await archiveConversation(b.id, msg.conversation_id, true);
    assert.equal((await listConversations(b.id)).length, 0, "b nao ve mais");
    assert.equal((await listConversations(a.id)).length, 1, "a continua vendo");
    await sendMessage(a, { body: "nova!", conversationId: msg.conversation_id });
    const lista = await listConversations(b.id);
    assert.equal(lista.length, 1, "voltou com a mensagem nova");
    assert.equal(lista[0].last_body, "nova!");
  });

  it("paginacao para tras nao repete mensagens", async () => {
    const a = usuario();
    const b = usuario();
    await gravarUsuario(a);
    await gravarUsuario(b);
    const conv = await ensureConversation(a.id, b.id);
    const ids: number[] = [];
    for (let i = 1; i <= 45; i++) {
      const [m] = await sendMessage(a, { body: `msg ${i}`, conversationId: conv });
      ids.push(m.id);
    }
    // o payload vem em ordem cronologica crescente (o cliente empilha na tela)
    const pagina1 = await listMessages(a.id, conv, 0, 40);
    assert.equal(pagina1.messages.length, 40);
    assert.equal(pagina1.messages[0].id, ids[5], "mais antiga dentro das 40 mais recentes");
    assert.equal(pagina1.messages.at(-1)!.id, ids[44], "mais recente por ultimo");
    const pagina2 = await listMessages(a.id, conv, pagina1.messages[0].id, 40);
    assert.equal(pagina2.messages.length, 5);
    assert.equal(pagina2.messages[0].id, ids[0], "a mais antiga de todas");
    assert.equal(pagina2.messages.at(-1)!.id, ids[4]);
  });
});
