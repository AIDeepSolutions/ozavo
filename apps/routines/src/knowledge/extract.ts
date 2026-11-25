import type { KnowledgeErrorCode, KnowledgeKind } from "@ozavo/core";
import { KNOWLEDGE_LIMITS } from "@ozavo/core";

/** Falha de extração com o motivo da tela (`KNOWLEDGE_ERROR_CODES`). A mensagem nunca traz texto do documento. */
export class KnowledgeExtractError extends Error {
  constructor(readonly code: KnowledgeErrorCode) {
    super(`Knowledge extraction failed: ${code}`);
    this.name = "KnowledgeExtractError";
  }
}

const startsWith = (raw: Buffer, bytes: number[]): boolean => bytes.every((byte, i) => raw[i] === byte);

/** Texto puro (txt e md): UTF-8, com recuo para Windows-1252, que é o que um editor antigo grava. */
function decodeText(raw: Buffer): string {
  if (raw.includes(0)) throw new KnowledgeExtractError("unreadable_file");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(raw);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** O HTML que o mammoth devolve, como texto com títulos (`## `), itens (`- `) e tabelas (`a | b`). */
export function htmlToText(html: string): string {
  return html
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "")}\n\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|ul|ol|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/ \| \n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

async function extractDocx(raw: Buffer): Promise<string> {
  if (!startsWith(raw, [0x50, 0x4b, 0x03, 0x04])) throw new KnowledgeExtractError("unreadable_file");
  const mammoth = await import("mammoth");
  try {
    const result = await mammoth.convertToHtml({ buffer: raw });
    return htmlToText(result.value);
  } catch {
    throw new KnowledgeExtractError("unreadable_file");
  }
}

async function extractPdf(raw: Buffer): Promise<string> {
  if (!startsWith(raw, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new KnowledgeExtractError("unreadable_file");
  const { getDocumentProxy, extractText } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(new Uint8Array(raw));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((page) => page.trim()).filter((page) => page !== "");
    // Um PDF só de imagem (digitalizado) não tem camada de texto: não há o que indexar sem OCR.
    if (pages.length === 0) throw new KnowledgeExtractError("scanned_pdf");
    return pages.join("\n\n");
  } catch (error) {
    if (error instanceof KnowledgeExtractError) throw error;
    throw new KnowledgeExtractError("unreadable_file");
  }
}

/** O texto do arquivo enviado. Vazio ou grande demais já recusa aqui, com o motivo. */
export async function extractKnowledgeText(kind: KnowledgeKind, raw: Buffer): Promise<string> {
  let text: string;
  if (kind === "pdf") text = await extractPdf(raw);
  else if (kind === "docx") text = await extractDocx(raw);
  else text = decodeText(raw);
  text = text.replace(/\u0000/g, "").trim();
  if (text === "") throw new KnowledgeExtractError(kind === "pdf" ? "scanned_pdf" : "empty_text");
  if (text.length > KNOWLEDGE_LIMITS.maxTextCharacters) throw new KnowledgeExtractError("source_too_large");
  return text;
}
