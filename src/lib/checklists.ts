/** Itens fixos dos checklists de entrega e retirada. */
export const CHECKLIST_ENTREGA = [
  "Equipamentos conferidos",
  "Quantidades conferidas",
  "Equipamentos higienizados",
  "Cliente recebeu os equipamentos",
  "Fotos registradas",
  "Observacoes registradas",
];

export const CHECKLIST_RETIRADA = [
  "Equipamentos recolhidos",
  "Quantidades conferidas",
  "Danos verificados",
  "Limpeza necessaria",
  "Fotos registradas",
  "Equipamentos devolvidos ao estoque",
];

export function checklistFor(kind: string) {
  return kind === "entrega" || kind === "montagem" ? CHECKLIST_ENTREGA : CHECKLIST_RETIRADA;
}
