import "server-only";
import { getSetting } from "./settings";
import { preparationValue } from "./availability-time";

export type StockOptions = { considerPreparation?: boolean; preparationMinutes?: number };

export async function preparationMinutes(): Promise<number> {
  return preparationValue((await getSetting("stock_preparation_minutes")) || "0");
}

export async function stockOptions(options: StockOptions = {}): Promise<Required<StockOptions>> {
  return { considerPreparation: options.considerPreparation !== false,
    preparationMinutes: options.considerPreparation === false ? 0 : preparationValue(options.preparationMinutes ?? await preparationMinutes()) };
}
