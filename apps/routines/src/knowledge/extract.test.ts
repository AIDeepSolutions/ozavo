import { describe, expect, it } from "vitest";
import { makeDocx, makePdf } from "../../test/documents";
import { KnowledgeExtractError, extractKnowledgeText, htmlToText } from "./extract";

describe("extractKnowledgeText", () => {
  it("lê um PDF com texto, uma página por bloco, com acentos", async () => {
    const pdf = makePdf([
      ["Manual da clínica", "O horário de atendimento é das 8h às 18h."],
      ["Preços", "A consulta custa R$ 150,00 (cento e cinquenta reais)."],
    ]);
    const text = await extractKnowledgeText("pdf", pdf);
    expect(text).toContain("Manual da clínica");
    expect(text).toContain("O horário de atendimento é das 8h às 18h.");
    expect(text).toContain("A consulta custa R$ 150,00 (cento e cinquenta reais).");
    expect(text.indexOf("Manual")).toBeLessThan(text.indexOf("Preços"));
  });

  it("recusa PDF sem texto (só imagem) com o motivo certo", async () => {
    await expect(extractKnowledgeText("pdf", makePdf([[]]))).rejects.toMatchObject({ code: "scanned_pdf" });
  });

  it("recusa arquivo que não é do tipo declarado", async () => {
    await expect(extractKnowledgeText("pdf", Buffer.from("isto não é um pdf"))).rejects.toMatchObject({ code: "unreadable_file" });
    await expect(extractKnowledgeText("docx", Buffer.from("isto não é um docx"))).rejects.toMatchObject({ code: "unreadable_file" });
    await expect(extractKnowledgeText("txt", Buffer.from([0x41, 0x00, 0x42]))).rejects.toBeInstanceOf(KnowledgeExtractError);
  });

  it("lê DOCX com títulos e parágrafos", async () => {
    const docx = await makeDocx(["# Política de cancelamento", "O cancelamento é gratuito até 24 horas antes.", "# Pagamento", "Aceitamos Pix & cartão."]);
    const text = await extractKnowledgeText("docx", docx);
    expect(text).toContain("# Política de cancelamento");
    expect(text).toContain("O cancelamento é gratuito até 24 horas antes.");
    expect(text).toContain("Aceitamos Pix & cartão.");
  });

  it("lê texto em UTF-8 (com BOM) e em Windows-1252, e recusa vazio", async () => {
    expect(await extractKnowledgeText("md", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Olá\n\nConteúdo")]))).toBe("# Olá\n\nConteúdo");
    expect(await extractKnowledgeText("txt", Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    await expect(extractKnowledgeText("txt", Buffer.from("  \n \n"))).rejects.toMatchObject({ code: "empty_text" });
  });
});

describe("htmlToText", () => {
  it("vira texto com títulos, itens e tabelas", () => {
    const html = "<h1>Preços</h1><p>Valores &amp; prazos</p><ul><li>Limpeza</li><li>Clareamento</li></ul><table><tr><td>Consulta</td><td>R$ 150</td></tr></table>";
    expect(htmlToText(html)).toBe("\n\n# Preços\n\nValores & prazos\n\n- Limpeza\n- Clareamento\n\nConsulta | R$ 150\n\n");
  });
});
