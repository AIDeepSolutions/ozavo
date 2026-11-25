import { describe, expect, it } from "vitest";
import { CONTEXT_MAX_TOKENS, formatRetrievedContext, knowledgeLanguageOf, knowledgeSystemSection } from "./knowledge-prompt";
import type { KnowledgeSearchHit } from "./types";

const hit = (n: number, tokenCount: number, over: Partial<KnowledgeSearchHit> = {}): KnowledgeSearchHit => ({
  chunkId: `chunk-${n}`,
  sourceId: `source-${n}`,
  sourceName: `Manual ${n}`,
  position: n,
  section: `Seção ${n}`,
  content: `Conteúdo do trecho ${n}.`,
  tokenCount,
  vectorScore: 0.5,
  lexicalRank: n,
  score: 0.03 - n / 1000,
  ...over,
});

describe("seção fixa do prompt", () => {
  const documents = [
    { id: "b", name: "Preços", text: "  Limpeza R$ 180.  " },
    { id: "a", name: "Horários", text: "Segunda a sexta." },
  ];

  it("lista os documentos por nome, sempre na mesma ordem, e não depende de nada que mude entre ligações", () => {
    const one = knowledgeSystemSection({ mode: "full", only: false, language: "pt-BR", documents });
    const two = knowledgeSystemSection({ mode: "full", only: false, language: "pt-BR", documents: [...documents].reverse() });
    expect(one).toBe(two);
    expect(one.indexOf("### Horários")).toBeLessThan(one.indexOf("### Preços"));
    expect(one).toContain("Limpeza R$ 180.");
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/);
  });

  it("no modo de busca só a instrução entra, sem documento", () => {
    const section = knowledgeSystemSection({ mode: "rag", only: false, language: "pt-BR", documents });
    expect(section).toContain("trechos");
    expect(section).not.toContain("Limpeza");
  });

  it("'responder só pela base' manda dizer que não tem a informação e oferecer recado ou transferência", () => {
    const only = knowledgeSystemSection({ mode: "rag", only: true, language: "pt-BR" });
    expect(only).toMatch(/não tem essa informação/);
    expect(only).toMatch(/recado|transferir/);
    expect(only).toMatch(/Nunca invente/);
    expect(knowledgeSystemSection({ mode: "rag", only: false, language: "pt-BR" })).not.toMatch(/Responda apenas/);
  });

  it("fala português, inglês e espanhol, e o que não conhece vira inglês", () => {
    expect(knowledgeLanguageOf("pt-BR")).toBe("pt");
    expect(knowledgeLanguageOf("es-MX")).toBe("es");
    expect(knowledgeLanguageOf("fr-FR")).toBe("en");
    expect(knowledgeSystemSection({ mode: "full", only: true, language: "en-US", documents })).toMatch(/Knowledge base[\s\S]*Never make things up/);
    expect(knowledgeSystemSection({ mode: "full", only: true, language: "es-ES", documents })).toMatch(/Base de conocimiento[\s\S]*Nunca inventes/);
  });

  it("manda falar natural: sem ler ids nem dizer 'segundo a base'", () => {
    expect(knowledgeSystemSection({ mode: "full", only: false, language: "pt-BR", documents })).toMatch(/Nunca leia códigos[\s\S]*segundo a base/);
  });
});

describe("trechos do turno", () => {
  it("mostra fonte e seção de cada trecho, sem id nem pontuação", () => {
    const { text, used } = formatRetrievedContext([hit(1, 50), hit(2, 50)], { language: "pt-BR", only: false });
    expect(used).toHaveLength(2);
    expect(text).toContain("[Manual 1 › Seção 1]\nConteúdo do trecho 1.");
    expect(text).toContain("[Manual 2 › Seção 2]");
    expect(text).not.toMatch(/chunk-|source-|0\.0\d/);
  });

  it("para no teto de tokens do bloco, e um trecho grande não tira os pequenos que ainda cabem", () => {
    const { used } = formatRetrievedContext([hit(1, 900), hit(2, 900), hit(3, 400)], { language: "pt-BR", only: false });
    expect(used.map((h) => h.position)).toEqual([1, 3]);
    expect(CONTEXT_MAX_TOKENS).toBe(1500);
  });

  it("um trecho sozinho acima do teto entra cortado, em palavra", () => {
    const huge = hit(1, 5000, { content: "palavra ".repeat(3000) });
    const { text, used } = formatRetrievedContext([huge], { language: "pt-BR", only: false, maxTokens: 100 });
    expect(used).toHaveLength(1);
    expect(text?.length).toBeLessThan(900);
    expect(text).toMatch(/…$/);
  });

  it("sem trecho: só diz que não achou quando o agente responde só pela base", () => {
    expect(formatRetrievedContext([], { language: "pt-BR", only: false }).text).toBeUndefined();
    expect(formatRetrievedContext([], { language: "pt-BR", only: true }).text).toMatch(/nenhum trecho relevante/);
    expect(formatRetrievedContext([], { language: "en", only: true }).text).toMatch(/no relevant passage/);
  });
});
