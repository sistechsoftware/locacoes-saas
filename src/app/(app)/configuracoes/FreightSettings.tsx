import { Field, Grid, Section } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
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
          {([
            ["fuel_price", "Preço por litro (R$)", c.fuelPriceCents/100],
            ["consumption", "Consumo (km/L)", c.consumption],
            ["cost_per_km", "Custo operacional por km (R$)", c.costPerKmCents/100],
            ["margin", "Margem sobre a venda (%)", c.marginPercent],
            ["minimum", "Valor mínimo (R$)", c.minimumCents/100],
            ["rounding", "Arredondamento (R$; 0 desliga)", c.roundingCents/100],
            ["labor", "Mão de obra (R$)", c.laborCents/100],
          ] as const).map(([name,label,value]) => <Field key={name} label={label}><input name={name} type="number" min={0} max={name === "margin" ? 95 : undefined} step="0.01" defaultValue={value} className="campo" disabled={!admin} /></Field>)}
        </Grid>
        <p className="text-xs text-stone-500">O modo manual preserva a fórmula existente. Rotas por endereço usam somente a quilometragem dos trechos exibidos, sem duplicar viagens.</p>
        {admin && <SubmitButton>Salvar {tipo === "comum" ? "Frete Comum" : "Frete de Locação"}</SubmitButton>}
      </form>
    </Section>;
  })}</div>;
}
