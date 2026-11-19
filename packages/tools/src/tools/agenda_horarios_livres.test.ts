import { describe, expect, it } from "vitest";
import { AGORA, HORARIOS_LIVRES, contextoDaAgenda, crmSimulado } from "../../test/agenda";
import { createAgendaHorariosLivres } from "./agenda_horarios_livres";

describe("agenda_horarios_livres", () => {
  it("consulta a janela pedida e devolve os horários livres com fuso", async () => {
    const crm = crmSimulado();
    const ctx = contextoDaAgenda();

    const result = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta", from: "2026-11-18T00:00:00-03:00", to: "2026-11-19T00:00:00-03:00" }, ctx);

    expect(result).toMatchObject({ ok: true, data: { slots: HORARIOS_LIVRES, timezone: "America/Sao_Paulo" } });
    expect(crm.pedidos.horarios).toEqual([
      { serviceType: "Consulta", from: "2026-11-18T03:00:00.000Z", to: "2026-11-19T03:00:00.000Z", durationMinutes: undefined, callId: "call-1" },
    ]);
    // O agente recebe a fala pronta do primeiro horário, e a ordem de confirmar antes de marcar.
    expect(result.message).toContain("18/11");
    expect(result.message).toContain("09:00");
    expect(result.message).toContain("confirmed=true");
    expect(ctx.said).toEqual(["Um instante, estou conferindo a agenda."]);
  });

  it("groupByDay (experimento da bancada, desligado por padrão) acrescenta todos os horários agrupados por dia; sem ele, a mensagem é a de sempre", async () => {
    const pedido = { service_type: "Consulta", from: "2026-11-18T00:00:00-03:00", to: "2026-11-19T00:00:00-03:00" };
    const padrao = await createAgendaHorariosLivres({ agenda: crmSimulado() }).run(pedido, contextoDaAgenda());
    const agrupado = await createAgendaHorariosLivres({ agenda: crmSimulado() }, { groupByDay: true }).run(pedido, contextoDaAgenda());

    expect(padrao.message).not.toContain("por dia");
    expect(agrupado.message).toContain("Todos os horários livres, por dia:");
    // A lista agrupada tem cada horário (hora no fuso da agenda) e o dia da semana por extenso.
    expect(agrupado.message).toMatch(/quarta-feira, 18\/11: [0-9:, ]*09:00/);
    expect(agrupado.message).toContain("manhã até 11:59");
    // O que o agente lê e os dados não mudam com a opção.
    expect(agrupado.data).toEqual(padrao.data);
  });

  it("o perfil do agente liga a lista agrupada pelo contexto da ligação (presentation); sem ele, a mensagem é a de sempre", async () => {
    const pedido = { service_type: "Consulta", from: "2026-11-18T00:00:00-03:00", to: "2026-11-19T00:00:00-03:00" };
    const tool = createAgendaHorariosLivres({ agenda: crmSimulado() });
    const ligado = await tool.run(pedido, { ...contextoDaAgenda(), presentation: { groupSlotsByDay: true } });
    const desligado = await tool.run(pedido, { ...contextoDaAgenda(), presentation: { groupSlotsByDay: false } });
    const semPerfil = await tool.run(pedido, contextoDaAgenda());

    expect(ligado.message).toContain("Todos os horários livres, por dia:");
    expect(desligado.message).not.toContain("por dia");
    expect(semPerfil.message).not.toContain("por dia");
  });

  it("sem período, consulta os próximos sete dias a partir do relógio da chamada", async () => {
    const crm = crmSimulado();
    await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta" }, contextoDaAgenda());

    expect(crm.pedidos.horarios[0]?.from).toBe(AGORA.toISOString());
    expect(crm.pedidos.horarios[0]?.to).toBe(new Date(AGORA.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
  });

  it("sem agenda ligada, recusa em voz alta e não chama ninguém", async () => {
    const ctx = contextoDaAgenda();
    const result = await createAgendaHorariosLivres().run({ service_type: "Consulta" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("não está ligada");
    expect(result.message).toContain("create_task");
    expect(ctx.said).toEqual([]);
  });

  it("janela invertida vira uma janela válida de um dia e informa a janela usada", async () => {
    const crm = crmSimulado();
    const result = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta", from: "2026-11-19T00:00:00-03:00", to: "2026-11-18T00:00:00-03:00" }, contextoDaAgenda());

    expect(result.ok).toBe(true);
    expect(crm.pedidos.horarios).toHaveLength(1);
    expect(crm.pedidos.horarios[0]).toMatchObject({ from: "2026-11-19T03:00:00.000Z", to: "2026-11-20T03:00:00.000Z" });
    expect(result.message).toContain("Janela consultada");
    expect(result.data).toMatchObject({ window: { from: "2026-11-19T03:00:00.000Z", to: "2026-11-20T03:00:00.000Z" } });
  });

  it("from igual a to (um instante só) consulta um dia a partir dele, sem erro", async () => {
    const crm = crmSimulado();
    const result = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta", from: "2026-11-20T14:00:00-03:00", to: "2026-11-20T14:00:00-03:00" }, contextoDaAgenda());

    expect(result.ok).toBe(true);
    expect(crm.pedidos.horarios[0]).toMatchObject({ from: "2026-11-20T17:00:00.000Z", to: "2026-11-21T17:00:00.000Z" });
    expect(result.message).toContain("Atenção");
  });

  it("não consulta o passado: o começo sobe para agora, e janela inteira no passado é recusada sem consultar", async () => {
    const crm = crmSimulado();
    const subiu = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta", from: "2026-11-10T09:00:00-03:00", to: "2026-11-20T09:00:00-03:00" }, contextoDaAgenda());
    expect(subiu.ok).toBe(true);
    expect(crm.pedidos.horarios[0]?.from).toBe(AGORA.toISOString());
    expect(subiu.message).toContain("já passou");

    const recusada = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta", from: "2026-11-10T09:00:00-03:00", to: "2026-11-10T09:00:00-03:00" }, contextoDaAgenda());
    expect(recusada).toMatchObject({ ok: false, noEffect: true });
    expect(recusada.message).toContain("já passou");
    expect(crm.pedidos.horarios).toHaveLength(1);
  });

  it("agenda sem vaga devolve lista vazia e não inventa horário", async () => {
    const crm = crmSimulado({ slots: [] });
    const result = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta" }, contextoDaAgenda());

    expect(result).toMatchObject({ ok: true, data: { slots: [] } });
    expect(result.message).toContain("Não há horário livre");
    expect(result.message).toContain("Não invente horário");
  });

  it("CRM fora do ar vira recusa falada, sem exceção", async () => {
    const crm = crmSimulado();
    crm.foraDoAr();

    const result = await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta" }, contextoDaAgenda());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ERRO DE CONSULTA");
    expect(result.message).toContain("NÃO diga que não há horário");
    expect(result.message).toContain("create_task");
    expect(result.data).toMatchObject({ error: "query_failed" });
  });

  it("erro de consulta e lista vazia são respostas diferentes: vazio só quando a consulta deu certo", async () => {
    const vazio = await createAgendaHorariosLivres({ agenda: crmSimulado({ slots: [] }) }).run({ service_type: "Consulta" }, contextoDaAgenda());
    const quebrado = crmSimulado();
    quebrado.foraDoAr();
    const erro = await createAgendaHorariosLivres({ agenda: quebrado }).run({ service_type: "Consulta" }, contextoDaAgenda());

    expect(vazio).toMatchObject({ ok: true, data: { slots: [] } });
    expect(vazio.message).not.toContain("ERRO DE CONSULTA");
    expect(erro.ok).toBe(false);
    expect(erro.message).not.toContain("Não há horário livre");
  });
});
