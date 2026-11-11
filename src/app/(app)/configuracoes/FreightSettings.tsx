import { Field, Grid, Section } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import MoneyInput from "@/components/MoneyInput";
import { freightConfig } from "@/lib/freight-config";
import { saveFreightSettings } from "./actions";

export default function FreightSettings({ settings, admin }: { settings: Record<string,string>; admin: boolean }) {
  return <div className="space-y-4">{(["comum", "locacao"] as const).map(tipo => {
    const c = freightConfig(settings, tipo);
    return <Section key={tipo} title={tipo === "comum" ? "Frete Comum" : "Frete de Locação"}>
      <form action={saveFreightSettings} className="space-y-3">
        <input type="hidden" name="tipo" value={tipo} />
        <Field label="Endereço-base" hint="Rua, número, bairro, cidade e estado. Independente do outro tipo de frete."><input name="base_address" defaultValue={c.baseAddress} maxLength={400} className="campo" disabled={!admin} /></Field>
        <Grid>
          <Field label="Combustível"><input name="fuel_type" defaultValue={c.fuelType} className="campo" disabled={!admin} /></Field>
          <Field label="Preço por litro (R$)"><MoneyInput name="fuel_price" defaultCents={c.fuelPriceCents} className="campo" disabled={!admin} /></Field>
          <Field label="Consumo (km/L)"><input name="consumption" type="number" min={0} step="0.01" defaultValue={c.consumption} className="campo" disabled={!admin} /></Field>
          <Field label="Custo operacional por km (R$)"><MoneyInput name="cost_per_km" defaultCents={c.costPerKmCents} className="campo" disabled={!admin} /></Field>
          <Field label="Margem sobre a venda (%)"><input name="margin" type="number" min={0} max={95} step="0.01" defaultValue={c.marginPercent} className="campo" disabled={!admin} /></Field>
          <Field label="Valor mínimo (R$)"><MoneyInput name="minimum" defaultCents={c.minimumCents} className="campo" disabled={!admin} /></Field>
          <Field label="Arredondamento (R$; 0 desliga)"><MoneyInput name="rounding" defaultCents={c.roundingCents} className="campo" disabled={!admin} /></Field>
          <Field label="Mão de obra (R$)"><MoneyInput name="labor" defaultCents={c.laborCents} className="campo" disabled={!admin} /></Field>
        </Grid>
        <p className="text-xs text-stone-500">O modo manual preserva a fórmula existente. Rotas por endereço usam somente a quilometragem dos trechos exibidos, sem duplicar viagens.</p>
        {admin && <SubmitButton>Salvar {tipo === "comum" ? "Frete Comum" : "Frete de Locação"}</SubmitButton>}
      </form>
    </Section>;
  })}</div>;
}
