import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1";
import { criarReserva, montarCenario, resetSequencia } from "./helpers/fixtures";
import { all, run, scalar } from "../src/lib/db";
import { addMinutes, availabilityQuery, normalizeStamp, preparationValue, timeWindow } from "../src/lib/availability-time";
import { availabilityAll, availabilityAllWithKits, availabilityByCategory, availabilityFor, checkConflicts, checkReservationConflicts, holdsForProduct, scanConflicts, timelinesByProduct } from "../src/lib/stock";
import { stockVersion, writeRental, STOCK_CHANGED, commitStockBatch } from "../src/lib/stock-write";
import { setSettings } from "../src/lib/settings";
import { dashboardStats } from "../src/lib/queries";

const rental = { from: "2026-09-06T13:00", to: "2026-09-07T13:00" };
const at = (h: string) => `2026-09-07T${h}`;
let c: Awaited<ReturnType<typeof montarCenario>>;
beforeEach(async () => { createTestDb(); resetSequencia(); c = await montarCenario(5, 20); });
const reserve = (qty = 5, status = "confirmada", w = rental) => criarReserva(c.clienteId, [{ product_id: c.kitId, qty }], status, w);
const available = async (t: string, preparation: boolean) => (await availabilityFor(c.kitId, t, t, null, { considerPreparation: preparation })).available;

describe("cenario exato do pedido, com kit consumindo mesa e quatro cadeiras", () => {
  for (const minutes of [0, 30, 60, 90, 120, 180]) {
    it(`libera exatamente apos ${minutes} minutos; um minuto antes ainda bloqueia`, async () => {
      await setSettings({ stock_preparation_minutes: String(minutes) });
      await reserve();
      const end = addMinutes(rental.to, minutes);
      assert.equal(await available(addMinutes(end, -1), true), 0);
      assert.equal(await available(end, true), 5);
      assert.equal(await available(addMinutes(end, 1), true), 5);
      assert.equal(await available(rental.to, false), 5);
      assert.equal(await available(at("12:59"), false), 0);
    });
  }
  for (const hour of ["12:00", "13:00", "14:00", "14:59", "15:00"]) {
    it(`com 120 minutos, consulta ${hour}`, async () => {
      await setSettings({ stock_preparation_minutes: "120" });
      await reserve();
      assert.equal(await available(at(hour), true), hour < "15:00" ? 0 : 5);
    });
  }
  for (const h of ["12:59", "13:00", "13:01", "14:00", "14:59", "15:00"]) {
    it(`nova reserva as ${h}, com e sem preparacao`, async () => {
      await setSettings({ stock_preparation_minutes: "120" });
      await reserve();
      for (const considerPreparation of [false, true]) {
        const conflicts = await checkConflicts([{ product_id: c.kitId, qty: 5 }], at(h), at("18:00"), null, { considerPreparation });
        assert.equal(conflicts.length > 0, h < (considerPreparation ? "15:00" : "13:00"));
      }
    });
  }
  it("a preparacao da NOVA reserva tambem respeita uma reserva futura", async () => {
    await setSettings({ stock_preparation_minutes: "120" });
    await reserve(5, "confirmada", { from: at("15:00"), to: at("18:00") });
    assert.equal((await checkConflicts([{ product_id: c.kitId, qty: 5 }], at("10:00"), at("14:00"))).length, 1);
    assert.equal((await checkConflicts([{ product_id: c.kitId, qty: 5 }], at("10:00"), at("13:00"))).length, 0);
    assert.equal((await checkConflicts([{ product_id: c.kitId, qty: 5 }], at("10:00"), at("14:00"), null, { considerPreparation: false })).length, 0);
  });
});

describe("intervalos, quantidades, status e normalizacao", () => {
  for (const w of [
    { from: at("09:00"), to: at("13:00") },
    { from: "2026-09-06T23:30", to: at("00:30") },
    { from: "2026-09-01T13:00", to: at("13:00") },
    { from: at("23:30"), to: "2026-09-08T00:30" },
  ]) it(`mesmo dia, meia-noite ou varios dias: ${w.from} ate ${w.to}`, async () => {
    await reserve(5, "confirmada", w);
    assert.equal(await available(w.from, false), 0);
    assert.equal(await available(addMinutes(w.to, -1), false), 0);
    assert.equal(await available(w.to, false), 5);
  });
  for (const status of ["pre_reserva", "confirmada", "entregue", "em_uso", "aguardando_retirada", "orcamento", "cancelada", "retirada", "finalizada"]) {
    it(`preserva a regra de status: ${status}`, async () => {
      await setSettings({ stock_preparation_minutes: "120" });
      await reserve(5, status);
      const holding = ["pre_reserva", "confirmada", "entregue", "em_uso", "aguardando_retirada"].includes(status);
      assert.equal(await available(at("12:00"), true), holding ? 0 : 5);
      assert.equal(await available(at("14:00"), true), holding ? 0 : 5);
      assert.equal(await available(at("14:00"), false), 5);
    });
  }
  it("10 kits: cinco mais tres simultaneos deixam dois livres; nao soma ocupacoes consecutivas", async () => {
    await run("UPDATE products SET total_qty=10 WHERE id=?", [c.mesaId]);
    await run("UPDATE products SET total_qty=40 WHERE id=?", [c.cadeiraId]);
    await setSettings({ stock_preparation_minutes: "120" });
    await reserve(5);
    await reserve(3, "confirmada", { from: at("14:00"), to: at("18:00") });
    assert.equal(await available(at("14:00"), true), 2);
    assert.equal(await available(at("15:00"), true), 7);
    assert.equal((await availabilityFor(c.kitId, at("00:00"), at("23:59"), null, { considerPreparation: false })).available, 5);
  });
  it("manutencao subtrai estoque fisico antes da capacidade dos kits", async () => {
    await run("UPDATE products SET maintenance_qty=4 WHERE id=?", [c.cadeiraId]);
    await reserve(2);
    assert.equal(await available(at("12:00"), false), 2);
  });
  it("nao perde hora ao ler espacos, segundos zero e timestamps com fuso", async () => {
    await reserve(5, "confirmada", { from: "2026-09-06 13:00:00", to: "2026-09-07T16:00:00Z" });
    assert.equal(await available(at("12:59"), false), 0);
    assert.equal(await available(at("13:00"), false), 5);
    assert.equal(normalizeStamp("2026-09-07T13:00:00-03:00"), at("13:00"));
    assert.equal(normalizeStamp("2026-09-07T01:00:00Z"), "2026-09-06T22:00");
  });
  it("recusa datas inexistentes, horarios invalidos, segundos nao representaveis e duracao zero", async () => {
    for (const value of ["2026-02-30T13:00", "2026-09-07T24:00", "2026-09-07T12:60", "2026-09-07T12:00:30", "lixo"]) assert.throws(() => normalizeStamp(value));
    assert.throws(() => timeWindow(at("13:00"), at("13:00")));
    assert.throws(() => timeWindow(at("14:00"), at("13:00")));
    await assert.rejects(checkConflicts([{ product_id: c.kitId, qty: 1 }], at("13:00"), at("13:00")));
    for (const n of [-1, 0.5, Infinity, "abc", 10081]) assert.throws(() => preparationValue(n));
  });
  it("detalhe usa snapshot antigo, nao a nova composicao do cadastro", async () => {
    const id = await reserve(5);
    await run("UPDATE product_components SET quantity=6 WHERE parent_product_id=? AND component_product_id=?", [c.kitId,c.cadeiraId]);
    assert.equal((await checkReservationConflicts(id)).length, 0);
    assert.equal((await checkConflicts([{ product_id: c.kitId, qty: 5 }], rental.from,rental.to,id)).length, 1);
  });
});

describe("mesma consulta em todos os consumidores", () => {
  it("disponibilidade, categorias, estoque, ficha, painel e linha do tempo concordam", async () => {
    await setSettings({ stock_preparation_minutes: "120" });
    await reserve();
    for (const h of ["12:59", "13:00", "14:59", "15:00"]) for (const considerPreparation of [false,true]) {
      const t = at(h), options = { considerPreparation };
      const expected = h < (considerPreparation ? "15:00" : "13:00") ? 0 : 5;
      const physical = await availabilityAll(t,t,null,options);
      const both = await availabilityAllWithKits(t,t,null,options);
      const groups = await availabilityByCategory(t,t,options);
      const timeline = await timelinesByProduct(t,t,options);
      const q = availabilityQuery({ inicio:t,preparo:considerPreparation?"1":"0" });
      const dashboard = await dashboardStats(q,options);
      assert.equal(physical.find(p => p.product_id === c.mesaId)!.available,expected);
      assert.equal(both.find(p => p.product_id === c.kitId)!.available,expected);
      assert.equal(groups.flatMap(g => g.products).find(p => p.product_id === c.kitId)!.available,expected);
      assert.equal(timeline.get(c.mesaId)![0].available,expected);
      assert.equal(dashboard.kits.find(p => p.product_id === c.kitId)!.available,expected);
      assert.equal((await holdsForProduct(c.mesaId,t,t,null,null,options)).length,expected===0?1:0);
    }
  });
  it("a consulta padrao e pontual e links preservam horario e checkbox desmarcado", () => {
    const q = availabilityQuery({}, at("15:00"));
    assert.equal(q.from,q.to);
    const off = availabilityQuery({ inicio:at("13:00"),consulta:"1" },at("15:00"));
    assert.equal(off.considerPreparation,false);
    assert.deepEqual(availabilityQuery(Object.fromEntries(new URLSearchParams(off.queryString))),off);
    assert.equal(availabilityQuery({data:"2026-09-06"},at("15:00")).from,"2026-09-06T15:00");
  });
  it("alertas contam ocupacao iniciada ontem e excessos autorizados", async () => {
    const older = await reserve(5);
    await run("UPDATE reservations SET stock_override=1 WHERE id=?",[older]);
    const newer = await reserve(1,"confirmada",{from:at("12:00"),to:at("14:00")});
    const scan = await scanConflicts("2026-09-07");
    assert.deepEqual(scan.map(r=>r.reservation_id),[newer]);
    assert.equal((await scanConflicts(at("14:00"),{considerPreparation:false},at("14:00"))).length,0);
    await setSettings({stock_preparation_minutes:"120"});
    assert.equal((await scanConflicts(at("14:00"),{},at("14:00"))).length,1);
  });
});

describe("gravacao atomica e concorrencia", () => {
  const header = () => ({ customer_id:c.clienteId,status:"confirmada",event_date:"2026-09-06",delivery_at:rental.from,pickup_at:rental.to });
  it("grava cabecalho, linhas e componentes juntos", async () => {
    const {id} = await writeRental(await stockVersion(),header(),[{product_id:c.kitId,qty:5}]);
    assert.equal(await available(at("12:00"),false),0);
    assert.equal(await scalar("SELECT COUNT(*) FROM reservation_item_components WHERE reservation_id=?",[id]),2);
  });
  it("duas criacoes com a mesma revisao: apenas uma confirma", async () => {
    const version = await stockVersion();
    await writeRental(version,header(),[{product_id:c.kitId,qty:5}]);
    await assert.rejects(writeRental(version,header(),[{product_id:c.kitId,qty:5}]),{message:STOCK_CHANGED});
    assert.equal(await scalar("SELECT COUNT(*) FROM reservations"),1);
  });
  it("edicao com revisao vencida conserva os itens originais", async () => {
    const id = await reserve(3);
    const version = await stockVersion();
    await reserve(1);
    await assert.rejects(writeRental(version,header(),[{product_id:c.kitId,qty:5}],id),{message:STOCK_CHANGED});
    assert.equal(await scalar("SELECT qty FROM reservation_items WHERE reservation_id=?",[id]),3);
  });
  it("falha depois de atualizar cabecalho desfaz tudo, inclusive DELETE de itens", async () => {
    const id = await reserve(3);
    const before = await all("SELECT * FROM reservation_items WHERE reservation_id=?",[id]);
    await assert.rejects(writeRental(await stockVersion(),{...header(),notes:"nao salvar"},[{product_id:999999,qty:1}],id));
    assert.deepEqual(await all("SELECT * FROM reservation_items WHERE reservation_id=?",[id]),before);
    assert.equal(await scalar("SELECT notes FROM reservations WHERE id=?",[id]),null);
  });
  it("mudanca de estoque, composicao ou configuracao invalida a verificacao anterior", async () => {
    for (const sql of ["UPDATE products SET maintenance_qty=1 WHERE kind='simples'", "UPDATE product_components SET quantity=quantity+1", "UPDATE settings SET value='120' WHERE key='stock_preparation_minutes'"]) {
      const v = await stockVersion();
      await run(sql);
      await assert.rejects(commitStockBatch(v,[]),{message:STOCK_CHANGED});
    }
  });
  it("IDs de reservas removidas nao sao reutilizados", async () => {
    const id = await reserve();
    await run("DELETE FROM reservations WHERE id=?",[id]);
    const next = await writeRental(await stockVersion(),header(),[{product_id:c.kitId,qty:1}]);
    assert.ok(next.id>id);
  });
});
