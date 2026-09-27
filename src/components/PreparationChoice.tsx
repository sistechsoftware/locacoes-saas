"use client";
import { addMinutes, windowError } from "@/lib/availability-time";
import { dateTimeBR } from "@/lib/format";

export default function PreparationChoice({ value, onChange, minutes, from, to }: {
  value: boolean; onChange: (v: boolean) => void; minutes: number; from: string; to: string;
}) {
  const valid = !windowError(from, to);
  return <div className="my-3 space-y-1 text-sm">
    <input type="hidden" name="consider_preparation" value={value ? "1" : "0"} />
    <label className="flex items-center gap-2"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />Considerar tempo de deslocamento e higienização</label>
    <p className="text-xs text-stone-500">Horário de São Paulo. {value ? `Considerando ${minutes} min de preparação em todas as reservas.` : "Sem tempo adicional."}
      {valid && ` Janela verificada: ${dateTimeBR(from)} até ${dateTimeBR(addMinutes(to, value ? minutes : 0))}.`}
    </p>
  </div>;
}
