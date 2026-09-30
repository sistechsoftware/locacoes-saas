import { redirect } from "next/navigation";
import { currentUser, destinoAposLogin } from "@/lib/auth";
import { estadoInstalacao } from "@/lib/primeiro-acesso";
import SetupForm from "./SetupForm";

export const dynamic = "force-dynamic";

/**
 * Primeiro acesso da instalacao (Etapa 13 do deploy SaaS).
 *
 * Disponivel SOMENTE enquanto nao existir usuario ativo nem empresa
 * configurada. Depois do primeiro cadastro a pagina passa a apenas apontar
 * para o login — a criacao dos proximos usuarios e logada, em Configuracoes.
 */
export default async function SetupPage() {
  const logado = await currentUser();
  if (logado) redirect(destinoAposLogin(logado));
  const estado = await estadoInstalacao();
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">Primeiro acesso</h1>
          <p className="text-sm text-stone-500">
            Crie o acesso do proprietário para começar a usar o sistema.
          </p>
        </div>

        <div className="cartao p-5 shadow-sm">
          {estado.instalacaoVazia ? (
            <SetupForm />
          ) : (
            <p className="text-sm text-stone-600">
              Esta instalação já possui um acesso configurado.{" "}
              <a href="/login" className="font-semibold text-marca-600 underline">
                Entrar
              </a>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
