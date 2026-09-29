import RecuperarForm from "./RecuperarForm";

export const dynamic = "force-dynamic";

/**
 * Pedido de recuperação de senha (público).
 *
 * A resposta é sempre a mesma, tenha ou não chegado e-mail — evita virar
 * dicionário de contas. O envio em si depende do Resend configurado.
 */
export default function RecuperarSenhaPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">Recuperar senha</h1>
          <p className="text-sm text-stone-500">Informe seu usuário para receber o link de redefinição.</p>
        </div>

        <div className="cartao p-5 shadow-sm">
          <RecuperarForm />
        </div>

        <p className="mt-5 text-center text-xs text-stone-500">
          <a href="/login" className="font-semibold text-marca-600 underline">
            Voltar para o login
          </a>
        </p>
      </div>
    </main>
  );
}
