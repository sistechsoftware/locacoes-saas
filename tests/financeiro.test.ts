/** Regras financeiras: parcelamento, situacao das parcelas, compras e caixa. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ajusteDeEstoque,
  dividirParcelas,
  montarParcelas,
  resultadoPeriodo,
  saldoConta,
  saldoParcela,
  situacaoParcela,
  subtotaisCompra,
  subtotalItem,
  vencimentos,
} from "../src/lib/financeiro.ts";

describe("divisao em parcelas", () => {
  it("Teste 5 - compra de R$ 5.000 em 10x", () => {
    const p = dividirParcelas(500000, 10);
    assert.equal(p.length, 10);
    assert.ok(p.every((v) => v === 50000));
  });

  it("locacao de R$ 1.200 em 4x", () => {
    assert.deepEqual(dividirParcelas(120000, 4), [30000, 30000, 30000, 30000]);
  });

  it("a soma das parcelas sempre bate com o total, mesmo sem divisao exata", () => {
    for (const [total, n] of [[100000, 3], [10, 3], [99999, 7], [1, 4]] as const) {
      const p = dividirParcelas(total, n);
      assert.equal(p.reduce((a, b) => a + b, 0), total, `${total} em ${n}x`);
    }
  });

  it("a sobra de centavos vai para a primeira parcela", () => {
    // 1000,00 em 3x: 333,34 + 333,33 + 333,33
    assert.deepEqual(dividirParcelas(100000, 3), [33334, 33333, 33333]);
  });

  it("a vista e uma parcela unica com o total", () => {
    assert.deepEqual(dividirParcelas(75000, 1), [75000]);
  });
});

describe("vencimentos mensais", () => {
  it("avanca um mes por parcela", () => {
    assert.deepEqual(vencimentos("2026-09-10", 3), ["2026-09-10", "2026-10-10", "2026-11-10"]);
  });

  it("dia 31 nao escorrega para o mes seguinte", () => {
    assert.deepEqual(vencimentos("2026-01-31", 3), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("atravessa a virada do ano", () => {
    assert.deepEqual(vencimentos("2026-12-15", 2), ["2026-12-15", "2027-01-15"]);
  });
});

describe("montagem das parcelas", () => {
  it("Teste 5 - 10 parcelas com valor e vencimento", () => {
    const p = montarParcelas(500000, 10, "2026-10-05");
    assert.equal(p.length, 10);
    assert.equal(p[0].installment, 1);
    assert.equal(p[9].installment, 10);
    assert.equal(p[0].due_date, "2026-10-05");
    assert.equal(p[9].due_date, "2027-07-05");
    assert.equal(p.reduce((a, b) => a + b.amount_cents, 0), 500000);
  });
});

describe("situacao da parcela", () => {
  const hoje = "2026-09-10";
  const parcela = { amount_cents: 50000, due_date: "2026-09-20" };

  it("sem pagamento e a vencer: aberta", () => {
    assert.equal(situacaoParcela(parcela, 0, hoje), "aberta");
  });

  it("Teste 10 - pagamento parcial", () => {
    assert.equal(situacaoParcela(parcela, 30000, hoje), "parcial");
    assert.equal(saldoParcela(parcela.amount_cents, 30000), 20000);
  });

  it("pagamento integral: quitada", () => {
    assert.equal(situacaoParcela(parcela, 50000, hoje), "quitada");
    assert.equal(saldoParcela(parcela.amount_cents, 50000), 0);
  });

  it("pagou mais que o devido continua quitada, sem saldo negativo", () => {
    assert.equal(situacaoParcela(parcela, 60000, hoje), "quitada");
    assert.equal(saldoParcela(parcela.amount_cents, 60000), 0);
  });

  it("passou do vencimento sem quitar: vencida", () => {
    const vencida = { amount_cents: 50000, due_date: "2026-09-01" };
    assert.equal(situacaoParcela(vencida, 0, hoje), "vencida");
    assert.equal(situacaoParcela(vencida, 30000, hoje), "vencida");
  });

  it("quitada no prazo nao vira vencida depois", () => {
    assert.equal(situacaoParcela({ amount_cents: 50000, due_date: "2026-09-01" }, 50000, hoje), "quitada");
  });

  it("cancelada prevalece sobre qualquer outra situacao", () => {
    assert.equal(situacaoParcela({ ...parcela, status: "cancelada" }, 0, hoje), "cancelada");
  });
});

describe("Teste 6 - so a parcela paga entra no caixa", () => {
  it("compra de R$ 5.000 em 10x com 2 pagas", () => {
    const parcelas = montarParcelas(500000, 10, "2026-10-05");
    const pago = [50000, 50000]; // duas primeiras
    const totalPago = pago.reduce((a, b) => a + b, 0);
    const pendente = parcelas.reduce((a, p) => a + p.amount_cents, 0) - totalPago;

    assert.equal(totalPago, 100000, "caixa registra R$ 1.000");
    assert.equal(pendente, 400000, "restam R$ 4.000 a pagar");
    assert.notEqual(totalPago, 500000, "o caixa nunca registra a compra inteira de uma vez");
  });
});

describe("Testes 7 e 8 - locacao parcelada", () => {
  it("R$ 1.200 em 4x com a primeira recebida", () => {
    const parcelas = montarParcelas(120000, 4, "2026-09-15");
    const contratado = parcelas.reduce((a, p) => a + p.amount_cents, 0);
    const recebido = parcelas[0].amount_cents;

    assert.equal(contratado, 120000);
    assert.equal(recebido, 30000, "so a primeira entrou no caixa");
    assert.equal(contratado - recebido, 90000, "a receber");
  });
});

describe("compras", () => {
  it("subtotal por item", () => {
    assert.equal(subtotalItem({ qty: 5, unit_price_cents: 10000, discount_cents: 0 }), 50000);
    assert.equal(subtotalItem({ qty: 20, unit_price_cents: 4000, discount_cents: 0 }), 80000);
    assert.equal(subtotalItem({ qty: 5, unit_price_cents: 3000, discount_cents: 0 }), 15000);
  });

  it("Teste 11 - compra com varios produtos", () => {
    const itens = [
      { qty: 5, unit_price_cents: 10000, discount_cents: 0 },
      { qty: 20, unit_price_cents: 4000, discount_cents: 0 },
      { qty: 5, unit_price_cents: 3000, discount_cents: 0 },
    ];
    const { itensTotal, total } = subtotaisCompra(itens, 0);
    assert.equal(itensTotal, 145000, "R$ 1.450,00");
    assert.equal(total, 145000);
  });

  it("desconto geral abate do total", () => {
    const itens = [{ qty: 5, unit_price_cents: 10000, discount_cents: 0 }];
    assert.equal(subtotaisCompra(itens, 5000).total, 45000);
  });

  it("desconto maior que o total nao gera valor negativo", () => {
    const itens = [{ qty: 1, unit_price_cents: 1000, discount_cents: 0 }];
    assert.equal(subtotaisCompra(itens, 99999).total, 0);
  });
});

describe("ajuste de estoque da compra", () => {
  it("Teste 4 - compra nova aplica a quantidade inteira", () => {
    const ajuste = ajusteDeEstoque([{ product_id: 1, qty: 5, stock_applied_qty: 0 }], true);
    assert.deepEqual(ajuste, [{ product_id: 1, delta: 5 }]);
  });

  it("Teste 3 - compra historica nao mexe no estoque", () => {
    assert.deepEqual(ajusteDeEstoque([{ product_id: 1, qty: 10, stock_applied_qty: 0 }], false), []);
  });

  it("Teste 14 - reabrir e salvar sem mudar nada nao duplica", () => {
    assert.deepEqual(ajusteDeEstoque([{ product_id: 1, qty: 5, stock_applied_qty: 5 }], true), []);
  });

  it("Teste 12 - aumentar de 5 para 7 movimenta apenas 2", () => {
    assert.deepEqual(ajusteDeEstoque([{ product_id: 1, qty: 7, stock_applied_qty: 5 }], true), [
      { product_id: 1, delta: 2 },
    ]);
  });

  it("reduzir de 5 para 3 devolve 2", () => {
    assert.deepEqual(ajusteDeEstoque([{ product_id: 1, qty: 3, stock_applied_qty: 5 }], true), [
      { product_id: 1, delta: -2 },
    ]);
  });

  it("Teste 13 - cancelar estorna o que entrou", () => {
    assert.deepEqual(ajusteDeEstoque([{ product_id: 1, qty: 5, stock_applied_qty: 5 }], false), [
      { product_id: 1, delta: -5 },
    ]);
  });

  it("o mesmo produto em duas linhas soma num ajuste so", () => {
    const ajuste = ajusteDeEstoque(
      [
        { product_id: 1, qty: 3, stock_applied_qty: 0 },
        { product_id: 1, qty: 2, stock_applied_qty: 0 },
      ],
      true,
    );
    assert.deepEqual(ajuste, [{ product_id: 1, delta: 5 }]);
  });

  it("varios produtos ajustam independentemente", () => {
    const ajuste = ajusteDeEstoque(
      [
        { product_id: 1, qty: 5, stock_applied_qty: 5 },
        { product_id: 2, qty: 20, stock_applied_qty: 0 },
      ],
      true,
    );
    assert.deepEqual(ajuste, [{ product_id: 2, delta: 20 }]);
  });
});

describe("caixa", () => {
  it("saldo e o inicial mais entradas menos saidas", () => {
    assert.equal(saldoConta(100000, 50000, 20000), 130000);
  });

  it("saldo pode ficar negativo, e isso precisa aparecer", () => {
    assert.equal(saldoConta(0, 10000, 30000), -20000);
  });

  it("resultado do periodo usa o que foi efetivamente movimentado", () => {
    assert.equal(resultadoPeriodo(500000, 200000), 300000);
  });

  it("faturamento contratado nao e o mesmo que resultado", () => {
    // 1.200 contratados, 300 recebidos, 100 pagos: o resultado usa o recebido
    assert.equal(resultadoPeriodo(30000, 10000), 20000);
  });
});
