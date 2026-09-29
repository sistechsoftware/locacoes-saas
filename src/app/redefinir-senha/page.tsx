import { redirect } from "next/navigation";
import RedefinirForm from "./RedefinirForm";

export const dynamic = "force-dynamic";

/**
 * Definição da senha nova a partir do link do e-mail (?token=...).
 *
 * Público por natureza: o token de 256 bits é a credencial — validado na
 * action. Sem token na query, manda para o pedido de recuperação.
 */
export default async function RedefinirSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  if (!token) redirect("/recuperar-senha");

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">Definir nova senha</h1>
          <p className="text-sm text-stone-500">Escolha uma senha forte — mínimo de 8 caracteres.</p>
        </div>

        <div className="cartao p-5 shadow-sm">
          <RedefinirForm token={token} />
        </div>
      </div>
    </main>
  );
}
