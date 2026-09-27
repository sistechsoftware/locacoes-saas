import { contractUsesHtml, sanitizeContractHtml } from "@/lib/contract-html";

/**
 * Corpo do contrato em tela, impressão e página pública.
 *
 * Um lugar só decide como o conteúdo é mostrado: contrato formatado (HTML
 * sanitizado na gravação) vira marcação; contrato antigo em texto puro segue
 * exatamente como sempre foi exibido, no mesmo <pre> de antes.
 *
 * O HTML é sanitizado de novo aqui por defesa em profundidade: contratos
 * editados à mão pelo administrador ou gravados por versões antigas do
 * sistema passam por esta porta também, então nada executável chega ao
 * navegador em nenhum caminho.
 */
export default function ContratoTexto({
  texto,
  className = "",
}: {
  texto: string | null | undefined;
  className?: string;
}) {
  if (contractUsesHtml(texto)) {
    return <div className={`contrato-rico ${className}`} dangerouslySetInnerHTML={{ __html: sanitizeContractHtml(texto ?? "") }} />;
  }
  return <pre className={`whitespace-pre-wrap font-sans ${className}`}>{texto}</pre>;
}
