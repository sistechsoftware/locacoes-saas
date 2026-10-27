import "server-only";
import { getSetting } from "./settings";
import { preparationValue } from "./availability-time";

export type StockOptions = { considerPreparation?: boolean; preparationMinutes?: number };

/**
 * Minutos de preparo da EMPRESA informada (escopo explícito). Sem empresa, o
 * comportamento legado lê pela sessão/empresa padrão — chamadas públicas sem
 * sessão (Loja Virtual) sempre passam o companyId para não herdar a
 * configuração de outra empresa.
 */
export async function preparationMinutes(companyId?: number): Promise<number> {
  if (companyId !== undefined) {
    const { settingsDaEmpresa } = await import("./settings");
    return preparationValue((await settingsDaEmpresa(companyId)).stock_preparation_minutes || "0");
  }
  return preparationValue((await getSetting("stock_preparation_minutes")) || "0");
}

export async function stockOptions(options: StockOptions = {}, companyId?: number): Promise<Required<StockOptions>> {
  return { considerPreparation: options.considerPreparation !== false,
    preparationMinutes: options.considerPreparation === false ? 0 : preparationValue(options.preparationMinutes ?? await preparationMinutes(companyId)) };
}
