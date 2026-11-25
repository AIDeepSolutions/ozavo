import type { ChatMessage } from "./openrouter-llm";

/**
 * Garante a ordem que o formato de chamada de função exige: depois da mensagem do assistente com `tool_calls`, VÊM os resultados
 * (`tool`), e só depois qualquer outra mensagem. Provedor rígido recusa o contrário com HTTP 400 (`invalid_tool_messages`): na ligação de
 * 25/11 a frase "Um instante, estou conferindo a agenda." entrava no histórico ENTRE a chamada e o resultado, o Together recusava
 * todo pedido dali em diante e a ligação inteira rodava no provedor reserva, ~0,9 s mais lenta por turno.
 *
 * A causa foi corrigida na sessão (`say` durante uma ferramenta), mas esta é a rede: o que está no meio sai do caminho. Fala do assistente
 * sem chamada vira continuação do texto da própria mensagem da chamada (é a fala que a antecedia); qualquer outra mensagem (a pessoa que
 * falou enquanto a ferramenta rodava) vai para depois dos resultados, na mesma ordem. Sem nada fora de ordem, devolve a mesma lista.
 */
export function repairToolOrder(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  let changed = false;
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as ChatMessage;
    if (message.role !== "assistant" || !message.tool_calls || message.tool_calls.length === 0) {
      out.push(message);
      continue;
    }
    const pending = new Set(message.tool_calls.map((call) => call.id));
    const results: ChatMessage[] = [];
    const between: ChatMessage[] = [];
    let end = i + 1;
    for (; end < messages.length && pending.size > 0; end++) {
      const next = messages[end] as ChatMessage;
      if (next.role === "tool" && pending.has(next.tool_call_id)) {
        pending.delete(next.tool_call_id);
        results.push(next);
      } else between.push(next);
    }
    // Resultado que falta (a ferramenta ainda roda) ou nada no meio: não há o que arrumar aqui.
    if (pending.size > 0 || between.length === 0) {
      out.push(message);
      continue;
    }
    changed = true;
    const spoken = between.filter((other): other is Extract<ChatMessage, { role: "assistant" }> => other.role === "assistant" && !other.tool_calls && typeof other.content === "string" && other.content !== "");
    const rest = between.filter((other) => !spoken.includes(other as Extract<ChatMessage, { role: "assistant" }>));
    const content = [message.content, ...spoken.map((other) => other.content)].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
    out.push({ ...message, content: content === "" ? null : content }, ...results, ...rest);
    i = end - 1;
  }
  return changed ? out : messages;
}
