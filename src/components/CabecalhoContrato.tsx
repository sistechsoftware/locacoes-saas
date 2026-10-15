import { docBR, phoneBR } from "@/lib/format";

/**
 * Cabeçalho do contrato: identidade da locadora acima do documento.
 *
 * Um lugar só decide como a empresa aparece no contrato digital — link público
 * de assinatura, via assinada no painel e via que o cliente vê no portal.
 * A logo entra apenas quando a empresa cadastrou (company_logo); CNPJ/CPF,
 * telefone e endereço só aparecem preenchidos, então uma empresa sem esses
 * dados continua vendo exatamente o cabeçalho de sempre: nome e subtítulo.
 */
export default function CabecalhoContrato({
  nome,
  subtitulo,
  logo,
  doc,
  telefone,
  endereco,
  cidade,
  className = "",
}: {
  nome: string;
  subtitulo?: string;
  logo?: string | null;
  doc?: string | null;
  telefone?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  className?: string;
}) {
  const contato = [doc ? `CNPJ/CPF ${docBR(doc)}` : "", telefone ? `Tel. ${phoneBR(telefone)}` : ""]
    .filter(Boolean)
    .join(" · ");
  const local = [endereco, cidade].filter(Boolean).join(" - ");

  return (
    <header className={`text-center ${className}`}>
      {logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt={nome} className="mx-auto mb-2 h-16 w-16 rounded-2xl object-contain" />
      )}
      <h1 className="text-lg font-bold text-tinta-900">{nome}</h1>
      {subtitulo && <p className="text-sm text-stone-600">{subtitulo}</p>}
      {contato && <p className="mt-1 text-xs text-stone-500">{contato}</p>}
      {local && <p className="text-xs text-stone-500">{local}</p>}
    </header>
  );
}
