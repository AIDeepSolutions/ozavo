import { describe, expect, it } from "vitest";
import { CHUNK_MAX_TOKENS, buildTsQuery, chunkText, countTokens, normalizeSearchText } from "./knowledge-chunking";

const sentence = (n: number): string => `A unidade ${n} atende de segunda a sexta, das oito às dezoito horas, e cobra consulta de avaliação por valor fixo.`;
const paragraph = (start: number, sentences: number): string => Array.from({ length: sentences }, (_, i) => sentence(start + i)).join(" ");

describe("chunkText", () => {
  it("devolve lista vazia para texto vazio", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("mantém um texto curto num trecho só, com a contagem de tokens do tokenizer", () => {
    const chunks = chunkText("Atendemos de segunda a sexta.");
    expect(chunks).toEqual([{ position: 0, section: null, content: "Atendemos de segunda a sexta.", tokenCount: countTokens("Atendemos de segunda a sexta.") }]);
  });

  it("parte um texto grande em trechos de no máximo 400 tokens, em ordem, sem perder nenhum parágrafo", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => paragraph(i * 10, 4));
    const chunks = chunkText(paragraphs.join("\n\n"));
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((chunk) => chunk.position)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(chunk.tokenCount).toBe(countTokens(chunk.content));
    }
    const joined = chunks.map((chunk) => chunk.content).join("\n");
    for (let i = 0; i < 30; i += 1) expect(joined).toContain(sentence(i * 10));
    // Trechos do meio ficam perto do alvo, não minúsculos.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.tokenCount).toBeGreaterThan(120);
  });

  it("repete o fim do trecho no começo do seguinte, na mesma seção", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => paragraph(i * 10, 3));
    const chunks = chunkText(paragraphs.join("\n\n"));
    for (let i = 1; i < chunks.length; i += 1) {
      const previousLast = chunks[i - 1]?.content.split("\n\n").at(-1)?.split(/(?<=[.!?])\s+/).at(-1) ?? "";
      expect(chunks[i]?.content).toContain(previousLast);
    }
  });

  it("reconhece títulos e guarda a seção de cada trecho", () => {
    const text = [`# Preços`, paragraph(0, 12), `## Convênios aceitos`, paragraph(50, 12), `3. Política de cancelamento`, paragraph(100, 12)].join("\n\n");
    const chunks = chunkText(text);
    const sections = new Set(chunks.map((chunk) => chunk.section));
    expect(sections).toEqual(new Set(["Preços", "Convênios aceitos", "3. Política de cancelamento"]));
    const first = chunks.find((chunk) => chunk.section === "Preços");
    expect(first?.content.startsWith("Preços")).toBe(true);
  });

  it("junta uma seção minúscula à vizinha em vez de fazer um trecho só com o título", () => {
    const chunks = chunkText(["# Horários", "Segunda a sexta, 8h às 18h.", "# Preços", paragraph(0, 6)].join("\n\n"));
    expect(chunks.every((chunk) => chunk.tokenCount > 20)).toBe(true);
    expect(chunks[0]?.content).toContain("Segunda a sexta, 8h às 18h.");
  });

  it("corta um parágrafo gigante, sem pontuação, por palavras", () => {
    const wall = Array.from({ length: 1500 }, (_, i) => `palavra${i}`).join(" ");
    const chunks = chunkText(wall);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
  });

  it("junta um último trecho pequeno demais ao anterior", () => {
    const chunks = chunkText([paragraph(0, 17), "Obrigado."].join("\n\n"));
    expect(chunks.at(-1)?.content).toContain("Obrigado.");
    expect(chunks.every((chunk) => chunk.tokenCount >= 20)).toBe(true);
  });
});

describe("busca por palavras", () => {
  it("tira acento e caixa", () => {
    expect(normalizeSearchText("Horário de Atendimento — São Paulo")).toBe("horario de atendimento — sao paulo");
  });

  it("monta a consulta com OU, sem palavra vazia nem repetida, e só com letras e números", () => {
    expect(buildTsQuery("Qual o horário de atendimento da clínica? Horário!")).toBe("horario | atendimento | clinica");
    expect(buildTsQuery("o que é isso?!")).toBeNull();
    expect(buildTsQuery("")).toBeNull();
    expect(buildTsQuery("'; drop table x; --")).toBe("drop | table");
  });
});
