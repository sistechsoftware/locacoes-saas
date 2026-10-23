import "server-only";
import { all, batch, one } from "./db";
import { descricaoTransferencia, grupoTransferenciaValido, validarTransferencia } from "./financeiro";

/**
 * Transferencia de valores entre contas — port fiel da Lima's Locações
 * (src/lib/transferencias.ts da origem), adaptada ao multi-tenant do SaaS.
 *
 * Um unico evento logico do caixa: o lado de saida e um pagamento NEGATIVO na
 * conta de origem e o de entrada, o pagamento POSITIVO na conta de destino.
 * Os dois lados compartilham o transfer_group e apontam um para o outro.
 *
 * Nao existe receita e despesa artificial: a receita do sistema e o livro
 * payments, e o lancamento negativo nao aumenta patrimonio nenhum. Os
 * indicadores (dashboard, relatorios, aba Entradas) excluem
 * `transfer_group IS NULL` (SQL_NAO_TRANSFERENCIA), entao a transferencia nao
 * aparece como receita. O livro de expenses fica intocado: transferencia nao e
 * despesa.
 *
 * A gravacao usa batch() do D1, que e transacao unica: ou os dois lados entram
 * juntos, ou nada entra.
 *
 * ISOLAMENTO ENTRE EMPRESAS (a grande diferença em relação à origem):
 *  * toda leitura e escrita carrega `company_id = ?` vindo do contexto
 *    autenticado — nunca do cliente;
 *  * as contas de origem e destino precisam pertencer à MESMA empresa do
 *    sessão; conta de outro tenant simplesmente "não existe";
 *  * o token de idempotência embute o company_id, então um token adulterado
 *    de outro tenant é recusado antes de tocar em banco.
 */

export type DadosTransferencia = {
  origemId: number;
  destinoId: number;
  valorCents: number;
  /** Data do calendario (YYYY-MM-DD), no fuso do negocio. */
  data: string;
  /** Observacao livre do operador; entra apos a descricao automatica. */
  observacao?: string;
  userId: number;
  /** Empresa dona das contas — vem do contexto autenticado, nunca do form. */
  companyId: number;
  /** Token de idempotência gerado na renderização do formulário. */
  grupo: string;
};

type Lado = {
  sql: string;
  params: any[];
};

/** Monta os dois lancamentos do evento: debito na origem, credito no destino. */
function ladosDoEvento(
  t: DadosTransferencia,
  nomes: { origem: string; destino: string },
): Lado[] {
  const sufixo = t.observacao?.trim() ? ` | ${t.observacao.trim()}` : "";
  const saida = descricaoTransferencia("saida", nomes.destino) + sufixo;
  const entrada = descricaoTransferencia("entrada", nomes.origem) + sufixo;

  return [
    {
      sql: `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, account_id, created_by, company_id, transfer_group)
            VALUES (NULL,NULL,?, 'transferencia', ?, ?, ?, ?, ?, ?)`,
      params: [-t.valorCents, t.data, saida, t.origemId, t.userId, t.companyId, t.grupo],
    },
    {
      sql: `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, account_id, created_by, company_id, transfer_group)
            VALUES (NULL,NULL,?, 'transferencia', ?, ?, ?, ?, ?, ?)`,
      params: [t.valorCents, t.data, entrada, t.destinoId, t.userId, t.companyId, t.grupo],
    },
  ];
}

/** Nomes das duas contas, SO se ambas pertencerem à empresa da sessão. */
async function nomesDasContas(origemId: number, destinoId: number, companyId: number) {
  const a = await one<any>(`SELECT id, name FROM financial_accounts WHERE id = ? AND company_id = ?`, [origemId, companyId]);
  const b = await one<any>(`SELECT id, name FROM financial_accounts WHERE id = ? AND company_id = ?`, [destinoId, companyId]);
  if (!a || !b) return null;
  return { origem: a.name, destino: b.name };
}

/** Os dois lados do evento, pela chave do grupo DENTRO da empresa. */
async function ladosDoGrupo(
  grupo: string,
  companyId: number,
): Promise<{ saida: any; entrada: any } | null> {
  const saida = await one<any>(
    `SELECT * FROM payments WHERE transfer_group = ? AND company_id = ? AND amount_cents < 0`,
    [grupo, companyId],
  );
  const entrada = await one<any>(
    `SELECT * FROM payments WHERE transfer_group = ? AND company_id = ? AND amount_cents >= 0`,
    [grupo, companyId],
  );
  if (!saida || !entrada) return null;
  return { saida, entrada };
}

/** Erro de unicidade do índice 0049: o MESMO token já tem lado de débito. */
function ehViolacaoDeUnicidade(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

/**
 * Grava a transferencia completa e devolve o id do lado de entrada.
 *
 * Idempotência: o grupo vem do formulário (token TF-<empresa>-<uuid>). Se o
 * mesmo formulário for reenviado (clique duplo, retry, requisição concorrente),
 * o índice único idx_pay_transfer_saida_unica (0049) recusa o segundo débito e
 * o lote inteiro é revertido — e então respondemos como sucesso já-realizado,
 * sem lançar nada de novo. Um envio genuinamente novo usa token novo.
 *
 * Primeiro os INSERT dentro do batch, depois o cross-reference: o D1 nao
 * resolve o id dentro do mesmo batch, entao o UPDATE dos pares vem depois. Se
 * algo falhar no meio, os dois lados continuam encontraveis pelo mesmo
 * transfer_group — e consertavel com um UPDATE, sem orphanos.
 */
export async function criarTransferencia(
  t: DadosTransferencia,
): Promise<{ id: number; grupo: string; duplicado?: true } | { erro: string }> {
  if (!grupoTransferenciaValido(t.grupo, t.companyId)) {
    return { erro: "Sessão inválida para esta transferência. Atualize a página e tente novamente." };
  }
  const erro = validarTransferencia(t.origemId, t.destinoId, t.valorCents, t.data);
  if (erro) return { erro };

  const nomes = await nomesDasContas(t.origemId, t.destinoId, t.companyId);
  if (!nomes) return { erro: "Conta de origem ou destino não encontrada." };

  const [saida, entrada] = ladosDoEvento(t, nomes);

  let rs: any[];
  try {
    rs = await batch([saida, entrada]);
  } catch (e) {
    // Reenvio do mesmo formulário: o índice único barrou o débito duplicado.
    // Se o evento já está completo, confirma como já-realizado (idempotente).
    if (ehViolacaoDeUnicidade(e)) {
      const lados = await ladosDoGrupo(t.grupo, t.companyId);
      if (lados) return { id: lados.entrada.id, grupo: t.grupo, duplicado: true };
    }
    return { erro: "A transferência não foi gravada. Nada foi lançado; tente novamente." };
  }

  const idSaida = Number(rs[0]?.meta?.last_row_id ?? 0);
  const idEntrada = Number(rs[1]?.meta?.last_row_id ?? 0);
  if (!idSaida || !idEntrada) return { erro: "A transferência não foi gravada. Nada foi lançado; tente novamente." };

  await batch([
    { sql: `UPDATE payments SET transfer_counterpart_id = ? WHERE id = ? AND transfer_group = ? AND company_id = ?`, params: [idEntrada, idSaida, t.grupo, t.companyId] },
    { sql: `UPDATE payments SET transfer_counterpart_id = ? WHERE id = ? AND transfer_group = ? AND company_id = ?`, params: [idSaida, idEntrada, t.grupo, t.companyId] },
  ]);

  return { id: idEntrada, grupo: t.grupo };
}

/**
 * Edita valor, data, contas e observacao de uma transferencia inteira.
 *
 * A regra e a diferenca, nao apagar e recriar: os ids originais sobrevivem
 * (recibos, auditoria e atalhos que apontam para eles continuam validos) e
 * uma falha no meio da edicao nunca deixa so um lado na tela. O sinal dos
 * valores continua mandando: saida negativa, entrada positiva.
 */
export async function editarTransferencia(
  grupo: string,
  t: DadosTransferencia,
): Promise<{ ok: true } | { erro: string }> {
  /* Sem checagem de FORMATO do grupo aqui: as 8 transferências migradas da
     Lima's trazem grupos no formato legado (TF-<epoch>-<rand>) e continuam
     editáveis. A barreira de IDOR é o company_id em TODA a consulta abaixo. */
  const erro = validarTransferencia(t.origemId, t.destinoId, t.valorCents, t.data);
  if (erro) return { erro };

  const lados = await ladosDoGrupo(grupo, t.companyId);
  if (!lados) return { erro: "Transferência não encontrada." };

  const nomes = await nomesDasContas(t.origemId, t.destinoId, t.companyId);
  if (!nomes) return { erro: "Conta de origem ou destino não encontrada." };

  const sufixo = t.observacao?.trim() ? ` | ${t.observacao.trim()}` : "";
  await batch([
    {
      sql: `UPDATE payments
              SET amount_cents = ?, paid_at = ?, account_id = ?, notes = ?
            WHERE id = ? AND transfer_group = ? AND company_id = ? AND transfer_counterpart_id IS NOT NULL`,
      params: [-t.valorCents, t.data, t.origemId, descricaoTransferencia("saida", nomes.destino) + sufixo, lados.saida.id, grupo, t.companyId],
    },
    {
      sql: `UPDATE payments
              SET amount_cents = ?, paid_at = ?, account_id = ?, notes = ?
            WHERE id = ? AND transfer_group = ? AND company_id = ? AND transfer_counterpart_id IS NOT NULL`,
      params: [t.valorCents, t.data, t.destinoId, descricaoTransferencia("entrada", nomes.origem) + sufixo, lados.entrada.id, grupo, t.companyId],
    },
  ]);
  return { ok: true };
}

/**
 * Reverte a transferencia removendo os DOIS lados de uma vez.
 *
 * batch() e transacao: ou os dois saem, ou nenhum sai — nunca fica um lado
 * orfao contando sozinho no saldo de uma conta.
 */
export async function excluirTransferencia(
  grupo: string,
  companyId: number,
): Promise<{ ok: true } | { erro: string }> {
  /* Grupo legado (migração) continua excluível: a proteção é o company_id
     em cada statement, não o formato do token. */
  const lados = await ladosDoGrupo(grupo, companyId);
  if (!lados) return { erro: "Transferência não encontrada." };

  await batch([
    { sql: `DELETE FROM payments WHERE id = ? AND transfer_group = ? AND company_id = ? AND amount_cents < 0`, params: [lados.saida.id, grupo, companyId] },
    { sql: `DELETE FROM payments WHERE id = ? AND transfer_group = ? AND company_id = ? AND amount_cents >= 0`, params: [lados.entrada.id, grupo, companyId] },
  ]);
  return { ok: true };
}

/**
 * Lista os grupos ainda completos, do mais recente ao mais antigo.
 *
 * O grupo com apenas um lado (falha historica, ou lado apagado isoladamente)
 * fica fora da lista até ser consertado: aparecer pela metade na tela seria
 * pior, porque a exclusao da tela removeria so o que ela enxerga.
 */
export async function listarTransferencias(companyId: number, limite = 100) {
  const grupos = await all<any>(
    `SELECT transfer_group AS grupo,
            MIN(CASE WHEN amount_cents < 0 THEN account_id END) AS origem_id,
            MAX(CASE WHEN amount_cents >= 0 THEN account_id END) AS destino_id,
            MIN(CASE WHEN amount_cents < 0 THEN amount_cents END) AS saida_cents,
            MAX(CASE WHEN amount_cents >= 0 THEN amount_cents END) AS entrada_cents,
            MIN(paid_at) AS data,
            MIN(CASE WHEN amount_cents < 0 THEN notes END) AS notes_saida,
            MAX(CASE WHEN amount_cents >= 0 THEN notes END) AS notes_entrada,
            COUNT(*) AS lados
       FROM payments
      WHERE company_id = ? AND transfer_group IS NOT NULL
      GROUP BY transfer_group
      HAVING COUNT(*) = 2
      ORDER BY data DESC, grupo DESC
      LIMIT ?`,
    [companyId, limite],
  );
  if (!grupos.length) return [];

  // nomes no momento da listagem: a descricao gravada ja carrega o nome da
  // epoca; aqui so complementa para o filtro atual ficar legivel
  const contas = await all<any>(
    `SELECT id, name FROM financial_accounts WHERE company_id = ? ORDER BY name COLLATE NOCASE`,
    [companyId],
  );
  const nomeDe = new Map<number, string>(contas.map((c: any) => [c.id, c.name]));

  return grupos.map((g: any) => ({
    grupo: g.grupo,
    origem_id: g.origem_id,
    destino_id: g.destino_id,
    origem_nome: nomeDe.get(g.origem_id) ?? "conta removida",
    destino_nome: nomeDe.get(g.destino_id) ?? "conta removida",
    valor_cents: Math.abs(Number(g.saida_cents ?? 0)) || Number(g.entrada_cents ?? 0),
    data: g.data,
    observacao: extrairObservacao(g.notes_saida, g.notes_entrada),
    descricao_saida: g.notes_saida,
    descricao_entrada: g.notes_entrada,
  }));
}

/** A observacao do operador vem depois do " | " na descricao gravada. */
function extrairObservacao(...notas: (string | null | undefined)[]): string {
  for (const n of notas) {
    if (!n) continue;
    const i = n.indexOf(" | ");
    if (i >= 0) return n.slice(i + 3);
  }
  return "";
}

/** Busca um grupo completo para os fluxos de editar/excluir. */
export async function transferenciaDoGrupo(grupo: string, companyId: number) {
  const lados = await ladosDoGrupo(grupo, companyId);
  if (!lados) return null;
  return {
    grupo,
    origem_id: lados.saida.account_id,
    destino_id: lados.entrada.account_id,
    valor_cents: Math.abs(lados.entrada.amount_cents),
    data: lados.entrada.paid_at,
    observacao: extrairObservacao(lados.saida.notes, lados.entrada.notes),
  };
}
