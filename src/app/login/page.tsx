import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  if (await currentUser()) redirect("/dashboard");
  const s = await getSettings();
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-nuvem-200 to-nuvem-100 p-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {s.company_logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.company_logo} alt="Logo" className="mx-auto mb-3 h-20 w-20 rounded-2xl object-contain" />
          ) : (
            <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center rounded-2xl bg-marca-600 text-3xl font-black text-white shadow-lg">
              L
            </div>
          )}
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">{s.company_name}</h1>
          <p className="text-sm text-stone-500">{s.company_tagline}</p>
        </div>

        <div className="cartao p-5 shadow-sm">
          <LoginForm />
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-stone-500">
          Acesso inicial: <b>admin / admin123</b> ou <b>operador / operador123</b>
          <br />
          Altere as senhas em Configurações após o primeiro acesso.
        </p>
      </div>
    </main>
  );
}
