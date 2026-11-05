/**
 * Identidade da locadora nos e-mails — camada PURA (sem banco, sem rede).
 *
 * O ponto mais delicado do cabeçalho é a LOGO. `company_settings.company_logo`
 * guarda o caminho interno do arquivo (`/api/arquivo/<id>`), que serve a tela
 * logada. Esse caminho não funciona em e-mail por dois motivos:
 *
 *  1. é RELATIVO — no cliente de e-mail não existe origem para resolver;
 *  2. `/api/arquivo/<id>` exige SESSÃO — o destinatário nunca está logado, e a
 *     imagem apareceria quebrada (era o defeito real do cabeçalho anterior).
 *
 * Aqui o caminho é convertido na rota PÚBLICA de logo
 * (`/api/publico/arquivo/<id>`, a única que o sistema expõe sem sessão) e
 * absolutizado com a origem pública do ambiente. Sem origem configurada, ou com
 * valor que não é imagem servível, devolve null e o layout cai no monograma da
 * empresa — nunca em imagem quebrada e nunca na logo de outra empresa.
 */

const HEX32 = /^[0-9a-f]{32}$/i;
const ROTA_LOGO = /^\/api\/(?:publico\/)?arquivo\/([0-9a-f]{32})$/i;
/** Esquemas que nunca viram src de imagem em e-mail. */
const ESQUEMA_PROIBIDO = /^(?:data|blob|javascript|vbscript|file):/i;

/**
 * Origem pública utilizável (``https://locogestao.com.br``), sem barra final.
 * Vazio quando ausente ou inválida — o chamador decide o fallback.
 */
export function normalizarBaseUrl(valor: string | null | undefined): string {
  const t = String(valor ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(t)) return "";
  return t;
}

/**
 * Caminho (relativo) da logo que o navegador consegue carregar SEM sessão:
 * `/api/publico/arquivo/<id>`, ou null quando o valor não é imagem servível.
 *
 * É a versão sem origem do urlLogoEmail, para páginas servidas a quem NÃO tem
 * sessão de equipe — login e primeiro acesso do portal e a área do cliente
 * (sessão de cliente, que a rota autenticada /api/arquivo/<id> não aceita).
 * Sem esta conversão o `company_logo` (`/api/arquivo/<id>`) volta 401 e a logo
 * aparece quebrada.
 */
export function rotaLogoPublica(valor: string | null | undefined): string | null {
  const bruto = String(valor ?? "").trim();
  if (!bruto) return null;
  if (ESQUEMA_PROIBIDO.test(bruto)) return null;

  // Caminho interno da logo: sempre converte para a rota pública.
  const rota = ROTA_LOGO.exec(bruto);
  if (rota) {
    const id = rota[1].toLowerCase();
    if (!HEX32.test(id)) return null;
    return `/api/publico/arquivo/${id}`;
  }

  // Rota de arquivo que não passou no formato estrito (id inválido) não é
  // imagem: apontar para ela daria 404/403.
  if (/^\/api\/(?:publico\/)?arquivo\//i.test(bruto)) return null;

  // Caminho relativo de asset real (ex.: /icones/loco-logo.png).
  if (bruto.startsWith("/")) {
    if (/[\s<>"]/.test(bruto)) return null;
    return bruto;
  }

  // URL absoluta: respeitada como está (não trocamos host de terceiros).
  if (/^https?:\/\/[^\s<>"]+$/i.test(bruto)) return bruto;
  return null;
}

/**
 * URL ABSOLUTA e pública da logo da empresa, ou null quando não há imagem
 * servível. `baseUrl` é a origem pública do ambiente (PUBLIC_URL).
 */
export function urlLogoEmail(valor: string | null | undefined, baseUrl: string | null | undefined): string | null {
  const rota = rotaLogoPublica(valor);
  if (!rota) return null;
  // URL absoluta (host de terceiros): sai como está, sem origem do ambiente.
  if (/^https?:\/\//i.test(rota)) return rota;
  // Caminho relativo só é utilizável no e-mail com origem conhecida.
  const base = normalizarBaseUrl(baseUrl);
  return base ? `${base}${rota}` : null;
}

/**
 * Monograma de fallback do cabeçalho — a alternativa quando a empresa não tem
 * logo cadastrada. É o MESMO desenho que o e-mail já usava (inicial em bloco
 * colorido), agora garantido também quando a imagem não carrega.
 */
export function monogramaEmpresa(nome: string | null | undefined): string {
  return String(nome ?? "")
    .trim()
    .charAt(0)
    .toUpperCase() || "L";
}
