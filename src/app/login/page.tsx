import { redirect } from "next/navigation";
import { currentUser, destinoAposLogin } from "@/lib/auth";
import { destinoInterno } from "@/lib/destino";
import LoginForm from "./LoginForm";

/**
 * Login.
 *
 * `?proximo=` volta o usuario para a pagina que ele estava abrindo. E o que
 * fecha o caminho da impressao no iPhone: o app instalado e o Safari tem
 * sessoes separadas, entao o documento aberto no Safari passa por aqui, o
 * usuario entra uma vez e cai de volta no documento (ja com ?imprimir=1).
 * Quem ja esta logado neste navegador nem ve o formulario.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redefinida?: string; proximo?: string }>;
}) {
  const sp = await searchParams;
  const proximo = destinoInterno(sp.proximo, "");
  const logado = await currentUser();
  if (logado) redirect(proximo || destinoAposLogin(logado));
  const senhaRedefinida = sp.redefinida === "1";
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-sm">
        {/*
         * Identidade do PRODUTO. A tela de login e anterior a qualquer
         * sessao, entao nao ha como saber de qual empresa o visitante e —
         * mostrar aqui a logo de um tenant exibiria a marca de uma empresa
         * para visitantes de outra. Logo/nome do cliente ficam na area
         * autenticada (company_settings, escopado por company_id).
         */}
        <div className="mb-6 text-center">
          <h1 className="sr-only">Locô — Gestão para locações</h1>
          {/*
           * Lockup oficial (brand/loco-logo.png), nao uma recriacao com a
           * fonte do sistema: wordmark e tagline sao a arte da marca.
           * largura limitada para o lockup nao estourar a coluna no celular.
           */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icones/loco-logo.png"
            alt=""
            className="mx-auto block h-auto w-full max-w-[19rem]"
          />
        </div>

        <div className="cartao p-5 shadow-sm">
          {senhaRedefinida && (
            <p className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Senha redefinida com sucesso. Entre com a senha nova.
            </p>
          )}
          {proximo && (
            <p className="mb-4 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              Entre para abrir o documento que você pediu neste navegador. Você volta direto para ele.
            </p>
          )}
          <LoginForm proximo={proximo} />
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-stone-500">
          <a href="/recuperar-senha" className="font-semibold text-marca-600 underline">
            Esqueci minha senha
          </a>
          <br />
          Não é cliente ainda?{" "}
          <a href="/planos" className="font-semibold text-marca-600 underline">
            Conheça os planos
          </a>
          <br />
          Instalação nova?{" "}
          <a href="/setup" className="font-semibold text-marca-600 underline">
            Configurar o primeiro acesso aqui
          </a>
        </p>
      </div>
    </main>
  );
}
