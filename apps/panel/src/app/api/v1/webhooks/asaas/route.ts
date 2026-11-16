import { asaasEvent, asaasPlatform, readAsaasConfig, receiveAsaasEvent, validAsaasToken, withOrg } from "@ozavo/core";
import { serverDeps } from "../../../../../server/context";

/** Autentica antes de ler o corpo. Erros não ecoam payload, token nem mensagens do Postgres. */
export async function POST(request: Request): Promise<Response> {
  try {
    const deps = serverDeps();
    const platformId = await asaasPlatform(deps.db);
    const config = platformId ? await withOrg(deps.db, platformId, readAsaasConfig) : null;
    if (!platformId || !config || !validAsaasToken(request.headers.get("asaas-access-token") ?? "", config.webhookToken, deps.secretKey)) {
      return Response.json({ ok: false }, { status: 401 });
    }
    // O webhook pode trazer objetos grandes: leitura limitada mesmo sem Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ ok: false }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > 256_000) { await reader.cancel(); return Response.json({ ok: false }, { status: 413 }); }
      chunks.push(chunk.value);
    }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return Response.json({ ok: false }, { status: 400 }); }
    const parsed = asaasEvent.safeParse(raw);
    if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
    if ((parsed.data.event.startsWith("PAYMENT_") && !parsed.data.payment) || (parsed.data.event.startsWith("SUBSCRIPTION_") && !parsed.data.subscription)) return Response.json({ ok: false }, { status: 400 });
    const result = await withOrg(deps.db, platformId, (q) => receiveAsaasEvent(q, config.environment, parsed.data, deps.clock.now()));
    return Response.json({ ok: true, data: { received: true, ...result } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
