import { KNOWLEDGE_LIMITS, KnowledgeLimitError, decryptSecret, type KnowledgeKind, type OrgQuery } from "@ozavo/core";
import { parsePipelineKey } from "@ozavo/voice-engine/pipeline-credentials";
import { z } from "zod";
import { ApiError, handle, type HandlerArgs, type AfterArgs } from "./context";
import { engineKeySetting } from "./pieces";

/** O motor em pipeline: a chave do OpenRouter dele é a que indexa e busca na base (a mesma da rotina `index_knowledge`). */
export const KNOWLEDGE_ENGINE = "deepgram-openrouter-cartesia";

/** A chave do OpenRouter da empresa, ou `null` quando o motor em pipeline não tem chave utilizável. */
export async function openRouterKeyOf(q: OrgQuery, secretKey: Buffer): Promise<string | null> {
  const row = await q.one<{ value: unknown }>("select value from settings where key = $1", [engineKeySetting(KNOWLEDGE_ENGINE)]);
  if (typeof row?.value !== "string") return null;
  try {
    return parsePipelineKey(decryptSecret(row.value, secretKey)).openrouter;
  } catch {
    return null;
  }
}

/** O que a pessoa enviou: um arquivo já conferido ou um texto colado. */
export interface KnowledgeUpload {
  kind: KnowledgeKind;
  /** Nome dado pela pessoa; vazio quando ela não escreveu um (o envio usa o do arquivo). */
  name: string | null;
  filename: string | null;
  raw?: Buffer;
  text?: string;
}

const EXTENSIONS: Record<string, KnowledgeKind> = { pdf: "pdf", docx: "docx", md: "md", markdown: "md", txt: "txt" };
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const startsWith = (raw: Buffer, bytes: number[]): boolean => bytes.every((byte, i) => raw[i] === byte);

/** A extensão manda no tipo; os primeiros bytes confirmam. `null`: extensão que não aceitamos, ou conteúdo que não é o que o nome diz. */
export function detectKnowledgeKind(filename: string, raw: Buffer): KnowledgeKind | null {
  const extension = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : undefined;
  const kind = extension === undefined ? undefined : EXTENSIONS[extension];
  if (kind === undefined) return null;
  if (kind === "pdf") return startsWith(raw, PDF_MAGIC) ? "pdf" : null;
  if (kind === "docx") return startsWith(raw, ZIP_MAGIC) ? "docx" : null;
  // Texto e Markdown: nada de PDF, de pacote zip nem de byte nulo com o nome trocado.
  if (startsWith(raw, PDF_MAGIC) || startsWith(raw, ZIP_MAGIC) || raw.includes(0)) return null;
  return kind;
}

const stripExtension = (filename: string): string => filename.replace(/\.[A-Za-z0-9]{1,8}$/, "");

const pastedText = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  text: z.string(),
});

const unsupported = (): ApiError => new ApiError(415, "knowledge_unsupported_type", "Only PDF, DOCX, Markdown and text files are accepted, and the content has to match the file type.");
const fileTooLarge = (): ApiError => new ApiError(413, "knowledge_file_too_large", `The file is over the ${KNOWLEDGE_LIMITS.maxFileBytes / (1024 * 1024)} MB limit.`);

/** Folga do corpo multipart sobre o arquivo (nome do campo, fronteiras, nome do arquivo). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Lê o envio: `multipart/form-data` com o campo `file` (e `name` opcional) ou JSON `{ name, text }` com texto
 * colado. Recusa pelo tamanho antes de ler quando o cabeçalho já diz que passa do limite.
 */
export async function readKnowledgeUpload(request: Request): Promise<KnowledgeUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > KNOWLEDGE_LIMITS.maxFileBytes + MULTIPART_OVERHEAD_BYTES && !contentType.startsWith("application/json")) throw fileTooLarge();
  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "invalid_upload", "The upload could not be read.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "validation_error", "file: a file is required");
    if (file.size === 0) throw new ApiError(422, "knowledge_empty", "The file is empty.");
    if (file.size > KNOWLEDGE_LIMITS.maxFileBytes) throw fileTooLarge();
    const raw = Buffer.from(await file.arrayBuffer());
    const kind = detectKnowledgeKind(file.name, raw);
    if (kind === null) throw unsupported();
    const rawName = form.get("name");
    const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : null;
    return { kind, name: name ?? stripExtension(file.name).slice(0, 200), filename: file.name.slice(0, 255), raw };
  }
  if (contentType.startsWith("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
    }
    const parsed = pastedText.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "validation_error", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
    if (parsed.data.text.trim() === "") throw new ApiError(422, "knowledge_empty", "The pasted text is empty.");
    if (parsed.data.text.length > KNOWLEDGE_LIMITS.maxTextCharacters) throw new ApiError(413, "knowledge_text_too_large", "The text is over the limit.");
    return { kind: "text", name: parsed.data.name ?? null, filename: null, text: parsed.data.text };
  }
  throw new ApiError(415, "knowledge_unsupported_type", "Send a file (multipart/form-data) or the pasted text as JSON.");
}

/** Os motivos do núcleo viram o código e o status da API; a frase da tela mora no dicionário `errors`. */
export function knowledgeError(error: unknown): unknown {
  if (!(error instanceof KnowledgeLimitError)) return error;
  const table: Record<KnowledgeLimitError["code"], [number, string]> = {
    empty: [422, "knowledge_empty"],
    name: [422, "knowledge_name"],
    file_too_large: [413, "knowledge_file_too_large"],
    text_too_large: [413, "knowledge_text_too_large"],
    too_many_sources: [409, "knowledge_too_many_sources"],
    organization_quota: [409, "knowledge_organization_quota"],
    not_found: [404, "not_found"],
    no_text: [422, "knowledge_no_text"],
    unsupported: [415, "knowledge_unsupported_type"],
  };
  const [status, code] = table[error.code];
  return new ApiError(status, code, error.message);
}

/** Embrulha `fn` para traduzir `KnowledgeLimitError` em resposta da API. */
export const translated =
  <A, R>(fn: (args: A) => Promise<R>) =>
  async (args: A): Promise<R> => {
    try {
      return await fn(args);
    } catch (error) {
      throw knowledgeError(error);
    }
  };

type UploadArgs = HandlerArgs<undefined> & { upload: KnowledgeUpload };

/**
 * Rota de envio: só dono e administrador; o corpo (arquivo ou texto) é lido e conferido DEPOIS de
 * autenticar e ANTES de abrir a transação, para um arquivo de 20 MB não segurar conexão do banco.
 */
export function handleUpload<R>(fn: (args: UploadArgs) => Promise<R>, after?: (result: R, args: AfterArgs<undefined>) => Promise<unknown>) {
  return (request: Request, context: Parameters<ReturnType<typeof handle>>[1]): Promise<Response> => {
    let upload: KnowledgeUpload | undefined;
    return handle<z.ZodType<undefined>, R>(
      {
        configure: true,
        before: async ({ request: incoming }) => {
          upload = await readKnowledgeUpload(incoming);
        },
        ...(after && { after }),
      },
      translated((args: HandlerArgs<undefined>) => {
        if (!upload) throw new ApiError(400, "validation_error", "body: nothing was sent");
        return fn({ ...args, upload });
      }),
    )(request, context);
  };
}
