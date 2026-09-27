import "server-only";
import { all, insert, one, scalar } from "./db";
import { getSettings } from "./settings";
import { today } from "./format";
import {
  aniversarioNoAno,
  chaveAviso,
  diasAte,
  diasDoMes,
  idade,
  idadeQueCompleta,
  janela,
  partes,
  primeiroNome,
  textoAviso,
  type TipoAviso,
} from "./aniversarios";

/**
 * Aniversariantes: consulta e rotina diaria.
 *
 * A busca nunca varre a tabela de clientes: o dia e o mes de hoje viram uma
 * lista curta de "MM-DD" e a consulta filtra por ela, apoiada no indice criado
 * na migracao. Uma base de dez mil clientes custa o mesmo que uma de dez.
 *
 * Os avisos entram na mesma caixa que o resto do sistema ja usa, com a chave
 * de deduplicacao segurando a repeticao. Nada aqui monta uma segunda central
 * de notificacoes.
 */

export type Aniversariante = {
  id: number;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  birth_date: string;
  /** Data em que cai o aniversario deste ciclo. */
  data: string;
  dias: number;
  idade: number | null;
  idadeQueCompleta: number | null;
};

export type Config = {
  ativo: boolean;
  diasAntecedencia: number;
  avisarHoje: boolean;
  avisarProximos: boolean;
  push: boolean;
  hora: number;
};

export async function configAniversarios(): Promise<Config> {
  const s = await getSettings();
  const num = (chave: string, padrao: number) => {
    const v = Number(s[chave]);
    return Number.isFinite(v) ? v : padrao;
  };
  return {
    ativo: s.birthday_active !== "0",
    diasAntecedencia: Math.max(0, Math.min(366, num("birthday_days_ahead", 7))),
    avisarHoje: s.birthday_notify_today !== "0",
    avisarProximos: s.birthday_notify_upcoming !== "0",
    push: s.birthday_push !== "0",
    hora: Math.max(0, Math.min(23, num("birthday_hour", 8))),
  };
}

const SELECT = `
  SELECT id, name, phone, whatsapp, email, birth_date
    FROM customers
   WHERE active = 1 AND birth_date IS NOT NULL AND birth_date <> ''`;

function montar(linhas: any[], hoje: string): Aniversariante[] {
  const p = partes(hoje)!;
  return linhas
    .map((c) => {
      const dias = diasAte(c.birth_date, hoje);
      if (dias === null) return null;
      const ano = dias === 0 || aniversarioNoAno(c.birth_date, p.ano)! >= hoje.slice(0, 10) ? p.ano : p.ano + 1;
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        whatsapp: c.whatsapp,
        email: c.email,
        birth_date: c.birth_date,
        data: aniversarioNoAno(c.birth_date, ano)!,
        dias,
        idade: idade(c.birth_date, hoje),
        idadeQueCompleta: idadeQueCompleta(c.birth_date, hoje),
      };
    })
    .filter((x): x is Aniversariante => x !== null)
    .sort((a, b) => a.dias - b.dias || a.name.localeCompare(b.name, "pt-BR"));
}

/** Clientes cujo aniversario cai dentro da janela de dias a partir de hoje. */
export async function aniversariantesNaJanela(dias: number, hoje = today()): Promise<Aniversariante[]> {
  const alvos = janela(hoje, dias);
  if (alvos.length === 0) return [];
  const linhas = await all<any>(
    `${SELECT} AND substr(birth_date, 6, 5) IN (${alvos.map(() => "?").join(",")})`,
    alvos,
  );
  return montar(linhas, hoje).filter((a) => a.dias <= dias);
}

export const aniversariantesDeHoje = (hoje = today()) => aniversariantesNaJanela(0, hoje);

/** Aniversariantes de um mes inteiro, para a visao de calendario. */
export async function aniversariantesDoMes(ano: number, mes: number, hoje = today()): Promise<Aniversariante[]> {
  const alvos = diasDoMes(ano, mes);
  const linhas = await all<any>(
    `${SELECT} AND substr(birth_date, 6, 5) IN (${alvos.map(() => "?").join(",")})`,
    alvos,
  );
  // aqui a ordem util e a do calendario, nao a proximidade de hoje
  return montar(linhas, hoje).sort((a, b) => a.birth_date.slice(5).localeCompare(b.birth_date.slice(5)));
}

/** Busca por nome ou telefone, dentro de um periodo. */
export async function buscarAniversariantes(
  filtro: { busca?: string; de?: string; ate?: string; mes?: number },
  hoje = today(),
): Promise<Aniversariante[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (filtro.busca) {
    // sem esta guarda, buscar por um nome deixaria o padrao do telefone como
    // '%%', que casa com a base inteira e faz a busca parecer quebrada
    const digitos = filtro.busca.replace(/\D/g, "");
    if (digitos) {
      where.push("(name LIKE ? OR replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ','') LIKE ?)");
      params.push(`%${filtro.busca}%`, `%${digitos}%`);
    } else {
      where.push("name LIKE ?");
      params.push(`%${filtro.busca}%`);
    }
  }
  if (filtro.mes) {
    where.push("substr(birth_date, 6, 2) = ?");
    params.push(String(filtro.mes).padStart(2, "0"));
  }
  const linhas = await all<any>(
    `${SELECT} ${where.length ? `AND ${where.join(" AND ")}` : ""} ORDER BY substr(birth_date, 6, 5) LIMIT 500`,
    params,
  );
  let saida = montar(linhas, hoje);
  if (filtro.de && filtro.ate) saida = saida.filter((a) => a.data >= filtro.de! && a.data <= filtro.ate!);
  return saida;
}

/** Quantos clientes ativos ainda nao tem data cadastrada. */
export async function clientesSemData(): Promise<number> {
  return await scalar<number>(
    `SELECT COUNT(*) FROM customers WHERE active = 1 AND (birth_date IS NULL OR birth_date = '')`,
  );
}

/** Numeros do cartao do painel, em duas consultas. */
export async function resumoAniversarios(hoje = today()) {
  const cfg = await configAniversarios();
  if (!cfg.ativo) return { ativo: false, hoje: [] as Aniversariante[], proximos: 0, diasAntecedencia: cfg.diasAntecedencia };
  const janelaToda = await aniversariantesNaJanela(cfg.diasAntecedencia, hoje);
  return {
    ativo: true,
    hoje: janelaToda.filter((a) => a.dias === 0),
    proximos: janelaToda.filter((a) => a.dias > 0).length,
    diasAntecedencia: cfg.diasAntecedencia,
  };
}

/* ------------------------------------------------------------------ */
/* Rotina diaria                                                       */
/* ------------------------------------------------------------------ */

/**
 * Cria um aviso para cada usuario ativo, uma unica vez.
 *
 * A chave de deduplicacao e o que segura a repeticao: rodar a rotina dez vezes
 * no mesmo dia cria um aviso so. O push e opcional e sai pela mesma fila do
 * resto do sistema, com reenvio e limpeza de inscricao invalida ja resolvidos.
 */
async function avisar(
  tipo: TipoAviso,
  chave: string,
  texto: { title: string; body: string },
  comPush: boolean,
): Promise<number> {
  const usuarios = await all<{ id: number }>(`SELECT id FROM users WHERE active = 1`);
  let criados = 0;
  for (const u of usuarios) {
    try {
      const id = await insert(
        `INSERT INTO user_notifications (user_id, event_id, type, title, body, link, created_at, dedupe_key)
         VALUES (?, NULL, 'aniversario', ?, ?, '/aniversarios', unixepoch(), ?)`,
        [u.id, texto.title, texto.body, `${chave}:u${u.id}`],
      );
      criados++;
      if (comPush) {
        // uma falha de push nao pode derrubar o aviso interno, que ja esta gravado
        try {
          await insert(
            `INSERT OR IGNORE INTO push_deliveries (notification_id, subscription_id)
             SELECT ?, s.id FROM push_subscriptions s WHERE s.user_id = ? AND s.enabled = 1`,
            [id, u.id],
          );
        } catch {
          /* a fila de push cuida do reenvio; o sino ja recebeu */
        }
      }
    } catch {
      // ja existe aviso desta situacao para este usuario
    }
  }
  return criados;
}

/**
 * Verifica os aniversarios do dia e prepara os avisos.
 *
 * Idempotente de ponta a ponta: pode rodar de novo depois de uma falha sem
 * duplicar nada, que e exatamente o que se espera de uma rotina automatica.
 */
export async function rotinaAniversarios(hoje = today()): Promise<{ hoje: number; proximos: number; avisos: number }> {
  const cfg = await configAniversarios();
  if (!cfg.ativo) return { hoje: 0, proximos: 0, avisos: 0 };

  const naJanela = await aniversariantesNaJanela(cfg.diasAntecedencia, hoje);
  const deHoje = naJanela.filter((a) => a.dias === 0);
  const proximos = naJanela.filter((a) => a.dias > 0);
  let avisos = 0;

  if (cfg.avisarHoje && deHoje.length > 0) {
    avisos += await avisar(
      "hoje",
      chaveAviso("hoje", 0, hoje),
      textoAviso("hoje", deHoje.map((a) => primeiroNome(a.name))),
      cfg.push,
    );
  }

  if (cfg.avisarProximos && proximos.length > 0) {
    // um aviso por dia de antecedencia, para a mensagem dizer algo util
    const porDia = new Map<number, Aniversariante[]>();
    for (const a of proximos) porDia.set(a.dias, [...(porDia.get(a.dias) ?? []), a]);
    for (const [dias, lista] of [...porDia.entries()].sort((a, b) => a[0] - b[0])) {
      avisos += await avisar(
        "proximo",
        chaveAviso("proximo", dias, hoje),
        textoAviso("proximo", lista.map((a) => primeiroNome(a.name)), dias),
        cfg.push,
      );
    }
  }

  return { hoje: deHoje.length, proximos: proximos.length, avisos };
}
