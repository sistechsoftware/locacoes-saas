"use client";
import { useEffect, useRef } from "react";
import { contractUsesHtml, plainTemplateToHtml, sanitizeContractHtml } from "@/lib/contract-html";

/**
 * Editor de formatacao do modelo de contrato.
 *
 * Este e o UNICO lugar do sistema com formatacao rica: Configuracoes ->
 * Modelos -> Modelo de contrato. Contratos gerados continuam seguindo o fluxo
 * de sempre — quem formata e o modelo, nao a tela de cada contrato.
 *
 * Nao ha biblioteca de editor no projeto, entao o editor usa contenteditable
 * com document.execCommand, recurso nativo dos navegadores (inclusive mobile),
 * sem dependencia nova. Na gravacao, o HTML passa pelo sanitizador do contrato
 * (lista branca de tags, atributos e estilos), que e a barreira de seguranca.
 *
 * Modelo antigo em texto puro abre aqui apenas convertendo quebras de linha em
 * <br>, para o usuario ver o texto como ele e. Enquanto o usuario nao mexer no
 * editor, o valor enviado no formulario continua sendo o texto original: abrir
 * a tela e salvar, sem editar, nao altera o modelo no banco.
 */

const FONTES = [
  { valor: "", label: "Fonte" },
  { valor: "Arial", label: "Arial" },
  { valor: "Georgia", label: "Georgia" },
  { valor: "Times New Roman", label: "Times New Roman" },
  { valor: "Courier New", label: "Courier New" },
  { valor: "Verdana", label: "Verdana" },
];

/** Escala do <font size> nativo: 3 e o tamanho normal. */
const TAMANHO_NORMAL = 3;
const TAMANHOS: Record<number, string> = {
  1: "Muito pequeno",
  2: "Pequeno",
  3: "Normal",
  4: "Médio",
  5: "Grande",
  6: "Muito grande",
  7: "Enorme",
};

const BOTAO =
  "inline-flex h-9 min-w-9 items-center justify-center rounded-lg border border-nuvem-300 bg-white px-2 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50 disabled:opacity-50";

export default function EditorContrato({
  name,
  valorInicial,
  disabled = false,
}: {
  name: string;
  valorInicial: string;
  disabled?: boolean;
}) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tamanhoRef = useRef(TAMANHO_NORMAL);
  // enquanto o usuario nao interagir, o formulario envia o texto original
  const mexeuRef = useRef(false);

  const htmlInicial = contractUsesHtml(valorInicial) ? valorInicial : plainTemplateToHtml(valorInicial);

  useEffect(() => {
    if (areaRef.current) areaRef.current.innerHTML = htmlInicial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sincronizar() {
    if (!mexeuRef.current || !inputRef.current) return;
    inputRef.current.value = sanitizeContractHtml(areaRef.current?.innerHTML ?? "");
  }

  function aplicar(fn: () => void) {
    const area = areaRef.current;
    if (!area || disabled) return;
    mexeuRef.current = true;
    area.focus();
    fn();
    sincronizar();
  }

  const comando = (cmd: string, valor?: string) => aplicar(() => document.execCommand(cmd, false, valor));

  function mudarTamanho(delta: number) {
    aplicar(() => {
      tamanhoRef.current = Math.min(7, Math.max(1, tamanhoRef.current + delta));
      document.execCommand("fontSize", false, String(tamanhoRef.current));
    });
  }

  function escolherTamanho(tamanho: string) {
    aplicar(() => {
      tamanhoRef.current = Number(tamanho) || TAMANHO_NORMAL;
      document.execCommand("fontSize", false, tamanho);
    });
  }

  function limparFormatacao() {
    aplicar(() => {
      document.execCommand("removeFormat");
      document.execCommand("formatBlock", false, "div");
    });
  }

  function colarComoTexto(e: React.ClipboardEvent<HTMLDivElement>) {
    if (disabled) return;
    e.preventDefault();
    const texto = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, texto);
    mexeuRef.current = true;
    sincronizar();
  }

  return (
    <div className="space-y-2">
      {!disabled && (
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-nuvem-300 bg-nuvem-50 p-1.5">
          <button type="button" className={`${BOTAO} font-bold`} title="Negrito" onClick={() => comando("bold")}>
            B
          </button>
          <button type="button" className={`${BOTAO} italic`} title="Itálico" onClick={() => comando("italic")}>
            I
          </button>
          <button type="button" className={`${BOTAO} underline`} title="Sublinhado" onClick={() => comando("underline")}>
            U
          </button>
          <span className="mx-1 h-6 w-px bg-nuvem-300" />
          <select
            className="h-9 rounded-lg border border-nuvem-300 bg-white px-1 text-sm"
            title="Tamanho da fonte"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) escolherTamanho(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Tamanho
            </option>
            {Object.entries(TAMANHOS).map(([valor, label]) => (
              <option key={valor} value={valor}>
                {label}
              </option>
            ))}
          </select>
          <button type="button" className={BOTAO} title="Aumentar fonte" onClick={() => mudarTamanho(1)}>
            A+
          </button>
          <button type="button" className={`${BOTAO} text-xs`} title="Diminuir fonte" onClick={() => mudarTamanho(-1)}>
            A−
          </button>
          <span className="mx-1 h-6 w-px bg-nuvem-300" />
          <button type="button" className={BOTAO} title="Alinhar à esquerda" onClick={() => comando("justifyLeft")}>
            ⯇
          </button>
          <button type="button" className={BOTAO} title="Centralizar" onClick={() => comando("justifyCenter")}>
            ≡
          </button>
          <button type="button" className={BOTAO} title="Alinhar à direita" onClick={() => comando("justifyRight")}>
            ⯈
          </button>
          <button type="button" className={`${BOTAO} px-1.5`} title="Justificar" onClick={() => comando("justifyFull")}>
            ☰
          </button>
          <span className="mx-1 h-6 w-px bg-nuvem-300" />
          <button type="button" className={BOTAO} title="Lista com marcadores" onClick={() => comando("insertUnorderedList")}>
            • Lista
          </button>
          <button type="button" className={`${BOTAO} px-2`} title="Lista numerada" onClick={() => comando("insertOrderedList")}>
            1. Lista
          </button>
          <button type="button" className={BOTAO} title="Linha horizontal" onClick={() => comando("insertHorizontalRule")}>
            —
          </button>
          <span className="mx-1 h-6 w-px bg-nuvem-300" />
          <select
            className="h-9 rounded-lg border border-nuvem-300 bg-white px-1 text-sm"
            title="Família da fonte"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) comando("fontName", e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              Fonte
            </option>
            {FONTES.slice(1).map((f) => (
              <option key={f.valor} value={f.valor}>
                {f.label}
              </option>
            ))}
          </select>
          <label className={`${BOTAO} cursor-pointer`} title="Cor do texto">
            🎨
            <input
              type="color"
              className="hidden"
              onChange={(e) => comando("foreColor", e.target.value)}
            />
          </label>
          <span className="mx-1 h-6 w-px bg-nuvem-300" />
          <button type="button" className={BOTAO} title="Desfazer" onClick={() => comando("undo")}>
            ↶
          </button>
          <button type="button" className={BOTAO} title="Refazer" onClick={() => comando("redo")}>
            ↷
          </button>
          <button type="button" className={`${BOTAO} px-2 text-xs`} title="Limpar formatação" onClick={limparFormatacao}>
            Limpar
          </button>
        </div>
      )}

      <div
        ref={areaRef}
        role="textbox"
        aria-multiline="true"
        aria-label="Modelo do contrato"
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={() => {
          mexeuRef.current = true;
          sincronizar();
        }}
        onBlur={sincronizar}
        onPaste={colarComoTexto}
        className="campo min-h-[24rem] max-h-[40rem] overflow-y-auto whitespace-pre-wrap font-sans text-sm"
      />

      {/* valor que vai para o server action; sincronizado com o editor a cada alteracao */}
      <input type="hidden" name={name} ref={inputRef} defaultValue={valorInicial} />

      {disabled && <p className="text-xs text-stone-500">Somente o administrador pode alterar o modelo.</p>}
    </div>
  );
}
