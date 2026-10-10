/**
 * Interface de login e cadastro de usuário INTERNO.
 *
 * Estes testes leem a fonte dos componentes (mesmo padrão de
 * assinatura-gate/autorizacao-matriz) para travar decisões de UI que a suíte
 * funcional não enxerga:
 *  - o campo de identificação tem rótulo/placeholder profissionais, sem
 *    exemplo de documento fictício e mencionando CPF, CNPJ e e-mail;
 *  - a opção visual de "conta antiga" NÃO existe mais na tela de login
 *    (a compatibilidade técnica com usuário legado permanece no backend);
 *  - o formulário de usuário interno (Configurações -> Usuários) não exige
 *    PF/PJ nem CPF/CNPJ — isso é exigência só do contratante (checkout/
 *    onboarding), validada em src/lib/usuarios.ts;
 *  - a recuperação de senha usa o mesmo vocabulário do login.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("texto do campo de login", () => {
  const fonte = ler("src/app/login/LoginForm.tsx");

  it("rótulo e placeholder explícitos: CPF, CNPJ ou e-mail", () => {
    assert.match(fonte, /label="CPF, CNPJ ou e-mail"/, "rótulo profissional com os três identificadores");
    assert.match(
      fonte,
      /placeholder="Informe seu CPF, CNPJ ou e-mail"/,
      "placeholder instrutivo, sem exemplo de documento/e-mail fictício",
    );
  });

  it("não restam exemplos fictícios no campo", () => {
    assert.ok(!fonte.includes("000.000.000-00"), "placeholder de CPF de mentira removido");
    assert.ok(!fonte.includes("voce@empresa.com"), "e-mail fictício removido do campo de login");
  });

  it("a opção visual de conta antiga foi removida", () => {
    assert.ok(!fonte.includes("Conta antiga"), "aviso de conta antiga não pode voltar à interface");
    assert.ok(!fonte.includes("usuário de login."), "dica residual removida");
  });
});

describe("recuperação de senha: mesmo vocabulário do login", () => {
  const fonte = ler("src/app/recuperar-senha/RecuperarForm.tsx");

  it("rótulo e placeholder alinhados com o login", () => {
    assert.match(fonte, /label="CPF, CNPJ ou e-mail cadastrado"/);
    assert.match(fonte, /placeholder="Informe seu CPF, CNPJ ou e-mail"/);
    assert.ok(!fonte.includes("000.000.000-00"), "sem exemplo de documento fictício");
  });

  it("mantém a explicação do canal seguro (link chega no e-mail)", () => {
    assert.match(fonte, /link chega no e-mail cadastrado/);
  });
});

describe("formulário de usuário interno (Configurações)", () => {
  const fonte = ler("src/app/(app)/configuracoes/UserForm.tsx");

  it("não exibe PF/PJ nem documento para usuário interno", () => {
    assert.ok(!fonte.includes("PessoaDocumentoFields"), "campo PF/PJ fora do cadastro interno");
    assert.ok(!fonte.includes("tipo_pessoa"), "sem input de tipo de pessoa");
    assert.ok(!fonte.includes('name="documento"'), "sem input de CPF/CNPJ");
  });

  it("mantém os campos exigidos pelo fluxo de autenticação (e-mail obrigatório)", () => {
    assert.match(fonte, /name="email"[^>]*required/);
    assert.match(fonte, /name="username"/);
    assert.match(fonte, /name="password"/);
  });

  it("a action de criação não repassa mais identidade do formulário interno", () => {
    const actions = ler("src/app/(app)/configuracoes/actions.ts");
    const bloco = actions.slice(actions.indexOf("export async function createUser"), actions.indexOf("export async function updateUser"));
    assert.ok(!bloco.includes("tipo_pessoa"), "createUser não lê tipo_pessoa do FormData");
    assert.ok(!bloco.includes('fd.get("documento")'), "createUser não lê documento do FormData");
  });
});
