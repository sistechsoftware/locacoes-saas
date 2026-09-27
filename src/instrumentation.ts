import { mensagemDeErro, registrarErro } from "./lib/error-log";

/**
 * Executado uma vez na inicializacao do servidor Next.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDb } = await import("./lib/db");
  const { ensureSeed } = await import("./lib/seed");
  const { purgeExpiredSessions } = await import("./lib/auth");
  const { purgeExpiredPortalSessions } = await import("./lib/portal-auth");
  getDb();
  await ensureSeed();
  await purgeExpiredSessions();
  await purgeExpiredPortalSessions();
}

type ContextoNext = {
  routerKind: "App Router" | "Pages Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "middleware";
  revalidateReason?: "on-demand" | "stale" | undefined;
};

/**
 * Captura TODOS os erros nao tratados do servidor (paginas, server actions e
 * route handlers) e guarda no diario error_logs — antes eles so existiam por
 * um instante no console do Workers, invisiveis para quem opera o sistema.
 *
 * O usuario logado e resolvido de dentro da funcao (e nao no modulo) para nao
 * acionar o banco fora de request. Falha aqui nao pode mascarar o erro
 * original: registrarErro ja engole as proprias excecoes.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: ContextoNext,
) {
  try {
    const { getUsuarioDaRequest } = await import("./lib/error-log-request");
    const usuario = await getUsuarioDaRequest(request.headers).catch(() => null);
    await registrarErro({
      source: "onRequestError",
      kind: "server",
      message: mensagemDeErro(error),
      route: context.routePath,
      method: request.method,
      digest: error instanceof Error && "digest" in error ? String((error as any).digest) : null,
      userId: usuario?.id ?? null,
      userName: usuario?.name ?? null,
      context: {
        url: request.path,
        routerKind: context.routerKind,
        routeType: context.routeType,
        revalidateReason: context.revalidateReason ?? null,
      },
    });
  } catch {
    // Nunca deixar a telemetria derrubar o tratamento do erro original.
  }
}
