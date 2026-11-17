import { recordOrgEvent } from "@ozavo/core";
import { handleApiKey } from "../../../../../server/api-auth";
import { failure, notFound, type RouteContext } from "../../../../../server/context";
import { outboundApiBody, requestOutboundCall } from "../../../../../server/outbound-api";

/**
 * Entrada de webhook: um sistema de fora (um formulário, um CRM, o n8n) avisa o Ozavo com
 * `Authorization: Bearer ozk_…`, numa chave com o escopo `hooks:inbound`. Sem o escopo, 403; o
 * limite por chave é o de toda rota de chave de API.
 *
 * Um `slug` nomeia o que o pedido faz, e cada requisição faz UMA coisa. Hoje existe `call`: pede UMA
 * ligação de saída, que passa pela mesma política (`checkOutboundAllowed`, lista de não ligar, janela,
 * teto e tentativas) de qualquer outra. Não há lote nem lista de números: o corpo é estrito, e
 * `toE164` é um telefone só. Não existe slug que enfileire tarefa avulsa: nenhuma rotina a consumiria.
 */
const call = handleApiKey({ scope: "hooks:inbound", body: outboundApiBody.strict() }, async (args) => {
  const result = await requestOutboundCall(args);
  await args.org((q) => recordOrgEvent(q, "inbound_hook_received", { slug: "call", apiKeyId: args.key.id, callId: result.data.callId, repeated: result.data.repeated }, args.deps.clock.now()));
  return result;
});

const SLUGS: Record<string, (request: Request) => Promise<Response>> = { call };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const slug = (await context.params)?.slug ?? "";
  const handler = Object.hasOwn(SLUGS, slug) ? SLUGS[slug] : undefined;
  return handler ? handler(request) : failure(notFound());
}
