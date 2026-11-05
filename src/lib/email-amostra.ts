/**
 * Dados FICTÍCIOS de demonstração — camada pura.
 *
 * Usados pela pré-visualização do editor e pelo e-mail de teste. Nenhum dado de
 * cliente real é lido e nenhum registro é criado: o objetivo é o administrador
 * ver exatamente o formato que o cliente recebe antes de ativar/personalizar.
 */
import type { FidelidadeEmail, OperacaoEmail, ReservaEmail } from "./email-templates";

export function amostraReserva(): ReservaEmail {
  return {
    cliente: "Cliente",
    clienteCompleto: "Cliente Exemplo",
    clienteEmail: "cliente@exemplo.com",
    clienteTelefone: "(11) 99999-0000",
    numero: "TESTE-0000",
    dataEvento: "01/01/2099",
    horaEvento: "10:00",
    inicio: "01/01/2099 08:00",
    fim: "01/01/2099 18:00",
    endereco: "Rua das Flores, 120, São Paulo",
    itens: [
      { nome: "Mesa", qtd: 10 },
      { nome: "Cadeira", qtd: 40 },
    ],
    rotuloInicio: "Entrega",
    rotuloFim: "Retirada",
    status: "Confirmada",
    motivo: "",
    alteracoes: ["Data do evento: 01/01/2099 → 02/01/2099"],
    valorTotal: "R$ 1.250,00",
    valorAdiantamento: "R$ 375,00",
    valorPendente: "R$ 875,00",
  };
}

export function amostraOperacao(): OperacaoEmail {
  return {
    cliente: "Cliente",
    clienteCompleto: "Cliente Exemplo",
    clienteEmail: "cliente@exemplo.com",
    clienteTelefone: "(11) 99999-0000",
    numero: "TESTE-0000",
    tipo: "Entrega",
    quando: "01/01/2099 08:00",
    endereco: "Rua das Flores, 120, São Paulo",
    status: "Confirmada",
    obs: "Portão de serviço, tocar o interfone.",
  };
}

export function amostraFidelidade(): FidelidadeEmail {
  return {
    cliente: "Cliente",
    clienteCompleto: "Cliente Exemplo",
    atual: 7,
    meta: 10,
    faltam: 3,
    unidade: "kits",
    unidadeSingular: "kit",
    beneficio: "1 kit grátis",
    quando: "30/11/2099",
    condicoes: [],
  };
}
