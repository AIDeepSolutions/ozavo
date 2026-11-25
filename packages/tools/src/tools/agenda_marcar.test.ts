import { describe, expect, it } from "vitest";
import { contextoDaAgenda, crmSimulado } from "../../test/agenda";
import { AgendaBookingFieldProblem } from "../connectors/agenda";
import { toolCalledArgs } from "../run-tool";
import { createAgendaMarcar } from "./agenda_marcar";

const ESCOLHIDO = "2026-11-18T14:00:00-03:00";

describe("agenda_marcar", () => {
  it("com a confirmação da pessoa, grava uma vez o horário escolhido", async () => {
    const crm = crmSimulado();
    const ctx = contextoDaAgenda();

    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true }, ctx);

    expect(result).toMatchObject({ ok: true, data: { appointmentId: "agendamento-1", startsAt: ESCOLHIDO } });
    expect(result.message).toContain("marcado");
    // O telefone vem da ligação, nunca do modelo.
    expect(crm.pedidos.marcacoes).toEqual([{ serviceType: "Consulta", startsAt: ESCOLHIDO, callId: "call-1", attendeePhone: "+5511988887777" }]);
    expect(ctx.said).toEqual(["Um instante, estou marcando."]);
  });

  it("sem a confirmação em voz alta, não escreve nada e pede a confirmação", async () => {
    const crm = crmSimulado();
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: false }, contextoDaAgenda());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("falta a confirmação");
    // Recusa antes de chamar a agenda: a vaga do teto por ligação volta.
    expect(result.noEffect).toBe(true);
    expect(result.message).toContain("confirmed=true");
    expect(crm.pedidos.marcacoes).toEqual([]);
    expect(crm.compromissos.size).toBe(0);
  });

  it("horário que já passou recusa sem escrever", async () => {
    const crm = crmSimulado();
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: "2026-11-17T09:00:00-03:00", confirmed: true }, contextoDaAgenda());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("já passou");
    // Recusa antes de chamar a agenda: a vaga do teto por ligação volta.
    expect(result.noEffect).toBe(true);
    expect(crm.pedidos.marcacoes).toEqual([]);
  });

  it("sem agenda ligada, recusa em voz alta mesmo com a confirmação", async () => {
    const result = await createAgendaMarcar().run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true }, contextoDaAgenda());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("não está ligada");
    // Recusa antes de chamar a agenda: a vaga do teto por ligação volta.
    expect(result.noEffect).toBe(true);
    expect(result.message).toContain("create_task");
  });

  it("CRM fora do ar vira recusa falada, sem exceção, e não promete horário marcado", async () => {
    const crm = crmSimulado();
    crm.foraDoAr();

    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true }, contextoDaAgenda());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("não respondeu");
    expect(result.message).toContain("NÃO diga que está marcado");
    // O CRM pode ter marcado antes de falhar: na dúvida, a vaga fica gasta.
    expect(result.noEffect).toBeUndefined();
    expect(crm.compromissos.size).toBe(0);
  });

  it("manda à agenda o nome, o e-mail, a empresa e o processo que a pessoa deu, junto com o telefone da ligação", async () => {
    const crm = crmSimulado();
    const result = await createAgendaMarcar({ agenda: crm }).run(
      { service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true, name: "Ana Souza", company: "Padaria Pão Quente", email: "ana.souza@paoquente.com.br", process: "Cobrança dos clientes inadimplentes", notes: "Prefere de manhã" },
      contextoDaAgenda(),
    );

    expect(result.ok).toBe(true);
    expect(crm.pedidos.marcacoes).toEqual([
      {
        serviceType: "Consulta",
        startsAt: ESCOLHIDO,
        callId: "call-1",
        attendeePhone: "+5511988887777",
        attendeeName: "Ana Souza",
        attendeeEmail: "ana.souza@paoquente.com.br",
        company: "Padaria Pão Quente",
        process: "Cobrança dos clientes inadimplentes",
        notes: "Prefere de manhã",
      },
    ]);
  });

  it("campo vazio é o mesmo que ausente: não vai para a agenda", async () => {
    const crm = crmSimulado();
    await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true, name: "", email: "", company: "", process: "" }, contextoDaAgenda());

    expect(crm.pedidos.marcacoes).toEqual([{ serviceType: "Consulta", startsAt: ESCOLHIDO, callId: "call-1", attendeePhone: "+5511988887777" }]);
  });

  it("e-mail que não é e-mail recusa antes de chamar a agenda e pede para soletrar de novo", async () => {
    const crm = crmSimulado();
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true, email: "ana arroba paoquente" }, contextoDaAgenda());

    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("soletrar");
    expect(crm.pedidos.marcacoes).toEqual([]);
  });

  it("a agenda que exige um dado que faltou devolve ao modelo o que perguntar, sem dizer que está marcado nem que caiu", async () => {
    const crm = crmSimulado();
    crm.book = async () => {
      throw new AgendaBookingFieldProblem("company", "missing");
    };
    const result = await createAgendaMarcar({ agenda: crm }).run({ service_type: "Consulta", starts_at: ESCOLHIDO, confirmed: true }, contextoDaAgenda());

    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("a empresa dela");
    expect(result.message).toContain("NÃO diga que está marcado");
    expect(result.message).not.toContain("não respondeu");
  });

  it("o texto da ferramenta manda perguntar uma coisa por vez, na ordem, e confirmar o e-mail soletrando", () => {
    const tool = createAgendaMarcar();
    const text = tool.description;

    expect(text.indexOf("o nome")).toBeLessThan(text.indexOf("a empresa"));
    expect(text.indexOf("a empresa")).toBeLessThan(text.indexOf("o e-mail"));
    expect(text.indexOf("o e-mail")).toBeLessThan(text.indexOf("o processo"));
    expect(text).toContain("UMA coisa por vez");
    expect(text).toContain("soletre");
    // Todos opcionais: agenda que não exige nada (Google, Cal sem campo obrigatório) continua marcando como antes.
    expect(tool.parameters).toMatchObject({ required: ["service_type", "starts_at", "confirmed"] });
  });

  it("nome, e-mail, empresa e processo são texto sobre quem ligou: a linha do tempo não os guarda", () => {
    const tool = createAgendaMarcar();
    expect(toolCalledArgs(tool, { name: "Ana", email: "ana@paoquente.com.br" })).toEqual({ omitted: "personal_text" });
  });
});
