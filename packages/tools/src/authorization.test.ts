import { describe, expect, it } from "vitest";
import { ConversationLog, appointmentIdsFromRequestContext, checkWriteAuthorization, isAffirmative, lastReadbackMatches, mentionsClockTime, mentionsDay, readsHour } from "./authorization";
import { AGORA, contextoDaAgenda, crmSimulado } from "../test/agenda";
import { createAgendaHorariosLivres } from "./tools/agenda_horarios_livres";
import { createAgendaMarcar } from "./tools/agenda_marcar";
import { createAgendaRemarcar } from "./tools/agenda_remarcar";
import { createAgendaCancelar } from "./tools/agenda_cancelar";

describe("isAffirmative", () => {
  it("aceita sim claro e recusa negação, pergunta e silêncio", () => {
    for (const ok of ["Sim, pode marcar.", "isso mesmo", "Pode ser", "Tá bom", "Confirmo", "Sim, pode confirmar. Não preciso de mais nada, obrigada.", "Pode marcar, obrigado. Preciso de mais alguma coisa?"]) expect(isAffirmative(ok), ok).toBe(true);
    for (const no of ["Não, melhor não", "Espera, na verdade quero outro dia", "Pode repetir?", "Quinta de manhã", "", undefined]) expect(isAffirmative(no), String(no)).toBe(false);
  });
});

describe("readsHour", () => {
  it("acha a hora do horário em número ou por extenso, em 24 h ou 12 h", () => {
    expect(readsHour("quinta-feira, 19/11, às 09:00", "2026-11-19T09:00:00-03:00")).toBe(true);
    expect(readsHour("quinta às nove horas, pode ser?", "2026-11-19T09:00:00-03:00")).toBe(true);
    expect(readsHour("sexta às três da tarde", "2026-11-20T15:00:00-03:00")).toBe(true);
    expect(readsHour("sexta às 14h", "2026-11-20T14:00:00-03:00")).toBe(true);
    expect(readsHour("sexta ao meio-dia", "2026-11-20T12:00:00-03:00")).toBe(true);
    expect(readsHour("quinta às dez", "2026-11-19T09:00:00-03:00")).toBe(false);
    expect(readsHour("segunda às doze horas", "2026-11-23T12:00:00-03:00")).toBe(true);
    expect(readsHour("quinta às 15h30", "2026-11-19T15:30:00-03:00")).toBe(true);
    // instante em UTC: a hora que a pessoa ouve é a do fuso da agenda (12:00Z = 9h em Brasília)
    expect(readsHour("quinta às 9 horas", "2026-11-19T12:00:00.000Z", "America/Sao_Paulo")).toBe(true);
    expect(readsHour("quinta às 12 horas", "2026-11-19T12:00:00.000Z", "America/Sao_Paulo")).toBe(false);
    // sem fuso conhecido, um instante em UTC não tem como ser conferido: não bloqueia
    expect(readsHour("qualquer coisa", "2026-11-19T12:00:00.000Z")).toBe(true);
    expect(readsHour(undefined, "2026-11-19T09:00:00-03:00")).toBe(false);
  });
});

function conversa(turns: [("user" | "agent"), string][], options?: { known?: string[] }): ConversationLog {
  const log = new ConversationLog(options?.known ? { knownAppointmentIds: options.known } : {});
  for (const [speaker, text] of turns) log.push(speaker, text);
  return log;
}

describe("isAffirmative: só vale a fala de assentimento", () => {
  it("pedido de outra coisa, mudança de ideia e 'pode falar' NÃO são sim (achado 1 da revisão)", () => {
    for (const no of ["quero outro horário", "pode ser outro dia", "Sim, mas na verdade quero quarta", "quero remarcar", "Certo, mas espera", "Pode falar o preço.", "Sim, porém prefiro de manhã", "Tudo bem, mas outra hora", "Não, não pode", "Pode não", "Isso, na verdade é sexta"]) expect(isAffirmative(no), no).toBe(false);
  });

  it("ótimo, tudo bem, bom e 'não, pode sim' valem como sim (falsos negativos da revisão)", () => {
    for (const ok of ["Ótimo", "Tudo bem", "Bom", "Não, pode sim", "Não... sim, pode", "Sim, pode confirmar", "Beleza, pode marcar.", "Claro"]) expect(isAffirmative(ok), ok).toBe(true);
  });
});

describe("a leitura confere hora, minuto e dia (achado 2 da revisão)", () => {
  const sexta14 = "2026-11-20T14:00:00-03:00";
  const sexta1430 = "2026-11-20T14:30:00-03:00";

  it("minuto: 14h não vale para 14h30, e 14h30 não vale para 14h", () => {
    expect(readsHour("sexta às 14h", sexta1430)).toBe(false);
    expect(readsHour("sexta às 14h30", sexta14)).toBe(false);
    expect(readsHour("sexta às 14h30", sexta1430)).toBe(true);
    expect(readsHour("sexta às 14 horas e meia", sexta1430)).toBe(true);
    expect(readsHour("sexta às duas e meia da tarde", sexta1430)).toBe(true);
    expect(readsHour("sexta às 4 e meia da tarde", "2026-11-20T16:30:00-03:00")).toBe(true);
    expect(readsHour("sexta ao meio-dia e meia", "2026-11-20T12:30:00-03:00")).toBe(true);
    expect(readsHour("sexta ao meio-dia", "2026-11-20T12:30:00-03:00")).toBe(false);
    expect(readsHour("sexta às dez e meia", "2026-11-20T10:30:00-03:00")).toBe(true);
    expect(readsHour("sexta às dez", "2026-11-20T10:30:00-03:00")).toBe(false);
  });

  it("dia: segunda dia 23 às 14h NÃO vale para a sexta 20 às 14h; o dia certo vale; sem dia lido, vale a hora", () => {
    expect(readsHour("segunda, dia 23, às 14h", sexta14)).toBe(false);
    expect(readsHour("sexta, dia 20, às 14h", sexta14)).toBe(true);
    expect(readsHour("sexta-feira, 20/11, às 14:00", sexta14)).toBe(true);
    expect(readsHour("dia 21 às 14h", sexta14)).toBe(false);
    expect(readsHour("20 de novembro às 14h", sexta14)).toBe(true);
    expect(readsHour("20 de dezembro às 14h", sexta14)).toBe(false);
    // O dia não foi lido: decisão documentada, vale hora e minuto.
    expect(readsHour("às 14h", sexta14)).toBe(true);
  });

  it("amanhã e hoje só são conferidos com o relógio da ligação", () => {
    const quinta = new Date("2026-11-19T13:00:00.000Z");
    expect(readsHour("amanhã às 14h", sexta14, "America/Sao_Paulo", quinta)).toBe(true);
    expect(readsHour("hoje às 14h", sexta14, "America/Sao_Paulo", quinta)).toBe(false);
    expect(readsHour("amanhã às 14h", sexta14)).toBe(true);
  });

  it("a última leitura decide o dia: o dia do bloco mais recente que cita algum", () => {
    expect(lastReadbackMatches(["Posso confirmar?", "Sexta, dia 20, às 14h."], sexta14)).toBe(true);
    expect(lastReadbackMatches(["Posso confirmar para segunda?", "Tenho sexta às 14h."], sexta14)).toBe(false);
    expect(lastReadbackMatches(["Certo, segunda, dia 23, às 14h. Posso confirmar?"], sexta14)).toBe(false);
    expect(mentionsDay("Posso confirmar?")).toBe(false);
    expect(mentionsDay("sexta-feira, 20/11")).toBe(true);
  });

  it("a fala da pessoa que cita outro dia ou hora não autoriza o horário gravado", () => {
    const leitura: Array<["agent" | "user", string]> = [["agent", "Sexta, dia 20, às 14h. Posso confirmar?"]];
    const com = (fala: string) => checkWriteAuthorization(conversa([...leitura, ["user", fala]], { known: [] }), { verb: "marcar", startsAt: sexta14, now: new Date("2026-11-18T13:00:00.000Z") });
    expect(com("Sim, pode marcar às 14h").ok).toBe(true);
    expect(com("Sim, às 15h").ok).toBe(false);
    expect(com("Sim, pode marcar na quinta").ok).toBe(false);
    expect(com("Sim, pode marcar na sexta").ok).toBe(true);
  });
});

describe("falsos bloqueios achados no replay sobre os brutos (R2, revalidação)", () => {
  it("minuto por extenso: 'quinze e trinta' e 'dezesseis e trinta' leem 15h30 e 16h30; 'dia vinte e cinco' não é hora", () => {
    expect(readsHour("terça, dia 24, às quinze e trinta", "2026-11-24T15:30:00-03:00")).toBe(true);
    expect(readsHour("sexta, dia 20, às dezesseis e trinta", "2026-11-20T16:30:00-03:00")).toBe(true);
    expect(readsHour("sexta, dia 20, às dezesseis e trinta", "2026-11-20T16:00:00-03:00")).toBe(false);
    expect(readsHour("às dez e quarenta e cinco", "2026-11-20T10:45:00-03:00")).toBe(true);
    expect(mentionsClockTime("quinze e trinta")).toBe(true);
    expect(mentionsClockTime("para o dia vinte e cinco de novembro")).toBe(false);
  });

  it("'troca', 'mudar' e 'alterar' são a ação confirmada numa remarcação, não mudança de ideia", () => {
    for (const ok of ["Sim, pode confirmar essa troca, por favor.", "Pode mudar, sim.", "Isso, pode alterar.", "Sim, pode confirmar essa troca para terça, 24, às 15h30."]) expect(isAffirmative(ok), ok).toBe(true);
    for (const no of ["Sim, mas quero trocar para outro dia", "Pode trocar, mas na verdade quero quarta"]) expect(isAffirmative(no), no).toBe(false);
  });

  it("'hoje' e 'amanhã' citados como contexto não derrubam a leitura quando há dia e data explícitos", () => {
    const quinta15 = "2026-11-19T15:00:00-03:00";
    const quarta = new Date("2026-11-18T13:00:00.000Z");
    expect(readsHour("Só para confirmar, hoje é quarta, 18 de novembro de 2026. Quer agendar para amanhã, quinta-feira, 19 de novembro, às 15h?", quinta15, "America/Sao_Paulo", quarta)).toBe(true);
    // Sem dia explícito, "hoje" ainda é conferido contra o relógio da ligação.
    expect(readsHour("hoje às 15h", quinta15, "America/Sao_Paulo", quarta)).toBe(false);
    expect(readsHour("amanhã às 15h", quinta15, "America/Sao_Paulo", quarta)).toBe(true);
  });

  it("remarcar com a leitura por extenso e o sim da pessoa passa; a mesma fala com a hora errada não", () => {
    const leitura: Array<["agent" | "user", string]> = [["agent", "Para confirmar: trocar sua consulta de sexta, dia vinte, às dez da manhã, para terça, dia vinte e quatro, às quinze e trinta. Posso confirmar?"], ["user", "Isso mesmo, pode confirmar, por favor."]];
    expect(checkWriteAuthorization(conversa(leitura, { known: [] }), { verb: "remarcar", startsAt: "2026-11-24T15:30:00-03:00", appointmentId: undefined }).ok).toBe(true);
    expect(checkWriteAuthorization(conversa(leitura, { known: [] }), { verb: "remarcar", startsAt: "2026-11-24T16:30:00-03:00" }).ok).toBe(false);
  });
});

describe("sem fuso conhecido a trava nega com mensagem ao modelo; sem conversation ela não age (achado 4 da revisão)", () => {
  const leitura: Array<["agent" | "user", string]> = [["agent", "Tenho quarta às nove horas. Pode marcar?"], ["user", "Sim, pode."]];

  it("horário em UTC e fuso desconhecido: nega, diz o que fazer, e nada é gravado", async () => {
    const crm = crmSimulado();
    const ctx = { ...contextoDaAgenda(), conversation: conversa(leitura) };
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-18T12:00:00.000Z", confirmed: true }, ctx);

    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("fuso");
    expect(result.message).toContain("agenda_horarios_livres");
    expect(crm.pedidos.marcacoes).toEqual([]);
  });

  it("o conector que declara o fuso dispensa a consulta prévia: marca conferindo a hora no fuso da agenda", async () => {
    const crm = Object.assign(crmSimulado(), { timezone: "America/Sao_Paulo" });
    const ctx = { ...contextoDaAgenda(), conversation: conversa(leitura) };
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-18T12:00:00.000Z", confirmed: true }, ctx);
    expect(result.ok).toBe(true);
    // 12:00Z são 9h em Brasília: o horário das 14h (17:00Z) continua recusado, porque a leitura foi das 9h.
    const outro = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-18T17:00:00.000Z", confirmed: true }, { ...contextoDaAgenda(), conversation: conversa(leitura) });
    expect(outro).toMatchObject({ ok: false, noEffect: true });
  });

  it("sem conversation (só teste de unidade ou script chama a ferramenta fora de call-session.ts), a trava não age", () => {
    expect(checkWriteAuthorization(undefined, { verb: "marcar", startsAt: "2026-11-18T12:00:00.000Z" })).toEqual({ ok: true });
  });
});

describe("ConversationLog", () => {
  it("devolve a última fala da pessoa e o que o agente leu logo antes dela", () => {
    const log = conversa([["agent", "Tenho quinta às nove."], ["agent", "Pode ser?"], ["user", "Sim"], ["agent", "Vou marcar."]]);
    expect(log.lastUserUtterance()).toBe("Sim");
    expect(log.agentBeforeLastUserUtterance()).toBe("Tenho quinta às nove. Pode ser?");
  });
});

describe("autorização das escritas da agenda", () => {
  const horario = "2026-11-18T09:00:00-03:00";

  it("marcar sem sim claro da pessoa: noEffect e nada gravado, mesmo com confirmed=true do modelo", async () => {
    const crm = crmSimulado();
    const ctx = { ...contextoDaAgenda(), conversation: conversa([["agent", "Tenho quarta às nove. Pode marcar?"], ["user", "Hum, deixa eu ver"]]) };
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: horario, confirmed: true }, ctx);

    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("não foi um sim claro");
    expect(crm.pedidos.marcacoes).toEqual([]);
  });

  it("marcar com sim, mas sem o agente ter lido a hora: noEffect", async () => {
    const crm = crmSimulado();
    const ctx = { ...contextoDaAgenda(), conversation: conversa([["agent", "Posso ajudar em mais alguma coisa?"], ["user", "Sim"]]) };
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: horario, confirmed: true }, ctx);

    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("ainda não leu");
    expect(crm.pedidos.marcacoes).toEqual([]);
  });

  it("a lista tinha 14h e 16h30, a última leitura foi 16h30 e a pessoa disse sim: gravar 14h é recusado, 16h30 grava", async () => {
    const quatorze = "2026-11-18T14:00:00-03:00";
    const dezesseisEMeia = "2026-11-18T16:30:00-03:00";
    const dialogo: Array<["agent" | "user", string]> = [
      ["agent", "Tenho quarta às 8h30, às 14h ou às 16h30. Qual prefere?"],
      ["user", "Eu disse quatro e meia. Quero às 16h30."],
      ["agent", "Certo, quarta-feira, às 16h30. Posso confirmar essa consulta?"],
      ["user", "Pode confirmar, por favor."],
    ];
    const crm = crmSimulado();
    const ctx = { ...contextoDaAgenda(), conversation: conversa(dialogo, { known: [] }) };
    const recusada = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: quatorze, confirmed: true }, ctx);

    expect(recusada).toMatchObject({ ok: false, noEffect: true });
    expect(recusada.message).toContain("outro dia ou hora");
    expect(crm.pedidos.marcacoes).toEqual([]);

    const aceita = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: dezesseisEMeia, confirmed: true }, ctx);
    expect(aceita.ok).toBe(true);
    expect(crm.pedidos.marcacoes).toHaveLength(1);
  });

  it("a última fala do agente não cita horário ('Posso confirmar?'): a conferência vale para a leitura do bloco anterior", () => {
    const log = conversa([["agent", "Tenho quarta às nove horas."], ["agent", "Posso confirmar?"], ["user", "Sim, pode."]], { known: [] });
    expect(checkWriteAuthorization(log, { verb: "marcar", startsAt: horario })).toEqual({ ok: true });
    expect(checkWriteAuthorization(log, { verb: "marcar", startsAt: "2026-11-18T14:00:00-03:00" }).ok).toBe(false);
  });

  it("mentionsClockTime reconhece números, 'h30', dois-pontos, por extenso e meio-dia, e ignora datas", () => {
    expect(["às 16h30", "às 14h", "10:30", "meio-dia", "quatro e meia", "duas da tarde", "nove horas"].map((t) => mentionsClockTime(t))).toEqual([true, true, true, true, true, true, true]);
    expect(["dia 20 de novembro", "Posso confirmar?", "sexta-feira"].map((t) => mentionsClockTime(t))).toEqual([false, false, false]);
  });

  it("hora falada com número e 'e meia' ou período do dia ('4 e meia da tarde', '2 da tarde') também conta como leitura de horário", async () => {
    expect(["4 e meia da tarde", "8 e meia da manhã, 2 da tarde ou 4 e meia da tarde", "10 e quinze", "3 da tarde"].map((t) => mentionsClockTime(t))).toEqual([true, true, true, true]);
    // O caso real da R2 (D03): a lista dizia "2 da tarde" (14h), a releitura final disse "4 e meia da tarde" (16h30) e a pessoa disse sim.
    const dialogo: Array<["agent" | "user", string]> = [
      ["agent", "Na quarta tenho três horários: 8 e meia da manhã, 2 da tarde ou 4 e meia da tarde. Qual você prefere?"],
      ["user", "Eu disse quatro e meia, quero às 16h30."],
      ["agent", "Entendi, 4 e meia da tarde, quarta-feira. Posso confirmar essa consulta?"],
      ["user", "Pode confirmar, por favor."],
    ];
    const crm = crmSimulado();
    const ctx = { ...contextoDaAgenda(), conversation: conversa(dialogo, { known: [] }) };
    const recusada = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-18T14:00:00-03:00", confirmed: true }, ctx);
    expect(recusada).toMatchObject({ ok: false, noEffect: true });
    const aceita = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-18T16:30:00-03:00", confirmed: true }, ctx);
    expect(aceita.ok).toBe(true);
  });

  it("marcar com leitura da hora e sim afirmativo: grava e a pessoa passa a ser dona do compromisso", async () => {
    const crm = crmSimulado();
    const conversation = conversa([["agent", "Tenho quarta às nove horas. Pode marcar?"], ["user", "Sim, pode."]], { known: [] });
    const ctx = { ...contextoDaAgenda(), conversation };
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: horario, confirmed: true }, ctx);

    expect(result.ok).toBe(true);
    expect(crm.pedidos.marcacoes).toHaveLength(1);
    expect(conversation.ownsAppointment("agendamento-1")).toBe(true);
  });

  it("cancelar e remarcar só aceitam compromisso desta pessoa; outro id vira noEffect sem tocar a agenda", async () => {
    const crm = crmSimulado();
    const conversation = conversa([["agent", "Confirmo: cancelar a consulta de sexta às 10h?"], ["user", "Sim"]], { known: ["apt-minha"] });
    const ctx = { ...contextoDaAgenda(), conversation };

    const cancelar = await createAgendaCancelar({ agenda: crm }).run({ appointment_id: "apt-de-outra-pessoa", appointment_starts_at: "2026-11-20T10:00:00-03:00", confirmed: true }, ctx);
    expect(cancelar).toMatchObject({ ok: false, noEffect: true });
    expect(cancelar.message).toContain("não está entre os que esta ligação conhece");

    const remarcar = await createAgendaRemarcar({ agenda: crm }).run({ appointment_id: "apt-de-outra-pessoa", starts_at: "2026-11-23T10:00:00-03:00", confirmed: true }, ctx);
    expect(remarcar).toMatchObject({ ok: false, noEffect: true });
    expect(crm.pedidos.cancelamentos).toEqual([]);
    expect(crm.pedidos.remarcacoes).toEqual([]);

    const propria = await createAgendaCancelar({ agenda: crm }).run({ appointment_id: "apt-minha", appointment_starts_at: "2026-11-20T10:00:00-03:00", confirmed: true }, ctx);
    expect(propria.noEffect).not.toBe(true);
    expect(crm.pedidos.cancelamentos).toHaveLength(1);
  });

  it("sem lista, nega por padrão: só vale o id marcado NESTA ligação (decisão do dono, opção b)", async () => {
    const crm = crmSimulado();
    const conversation = conversa([["agent", "Confirmo: cancelar a consulta de sexta às 10h?"], ["user", "Sim"]]);
    const ctx = { ...contextoDaAgenda(), conversation };
    const pedido = { appointment_id: "apt-qualquer", appointment_starts_at: "2026-11-20T10:00:00-03:00", confirmed: true };

    expect(await createAgendaCancelar({ agenda: crm }).run(pedido, ctx)).toMatchObject({ ok: false, noEffect: true });
    expect(crm.pedidos.cancelamentos).toEqual([]);

    conversation.rememberAppointment("apt-qualquer");
    expect((await createAgendaCancelar({ agenda: crm }).run(pedido, ctx)).noEffect).not.toBe(true);
    expect(crm.pedidos.cancelamentos).toHaveLength(1);
  });

  it("ids informados pelo operador (request_context.appointmentIds) e pelo ponto de extensão valem; qualquer outra forma é ignorada", () => {
    expect(appointmentIdsFromRequestContext({ appointmentIds: ["a1", "a2"], outro: 1 })).toEqual(["a1", "a2"]);
    expect(appointmentIdsFromRequestContext({ appointmentIds: ["a1", 2, "", "  ", "x".repeat(201), null] })).toEqual(["a1"]);
    expect(appointmentIdsFromRequestContext({ appointmentIds: Array.from({ length: 80 }, (_, i) => `id${i}`) })).toHaveLength(50);
    for (const ruim of [undefined, null, "a1", ["a1"], { appointmentIds: "a1" }, { appointmentIds: { 0: "a1" } }]) expect(appointmentIdsFromRequestContext(ruim)).toEqual([]);

    const conversation = new ConversationLog();
    expect(conversation.ownsAppointment("a1")).toBe(false);
    conversation.allowAppointments(appointmentIdsFromRequestContext({ appointmentIds: ["a1"] }));
    expect(conversation.ownsAppointment("a1")).toBe(true);
    expect(conversation.ownsAppointment("a2")).toBe(false);
  });

  it("horário em UTC copiado da consulta: a hora lida é a do fuso da agenda, que a consulta de horários registra", async () => {
    const crm = crmSimulado();
    const conversation = conversa([["agent", "Tenho quarta às nove horas. Pode marcar?"], ["user", "Sim, pode."]]);
    const ctx = { ...contextoDaAgenda(), conversation };
    await createAgendaHorariosLivres({ agenda: crm }).run({ service_type: "Consulta" }, ctx);
    expect(conversation.agendaTimezone()).toBe("America/Sao_Paulo");

    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-18T12:00:00.000Z", confirmed: true }, ctx);
    expect(result.ok).toBe(true);
    expect(crm.pedidos.marcacoes).toHaveLength(1);
  });

  it("sem conversation no contexto (canal que não declara), a trava não age", () => {
    expect(checkWriteAuthorization(undefined, { verb: "marcar", startsAt: horario })).toEqual({ ok: true });
    expect(AGORA.getTime()).toBeGreaterThan(0);
  });
});
