import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatToolCall } from "./openrouter-llm";
import { repairToolOrder } from "./tool-order";

const call = (id: string): ChatToolCall => ({ id, type: "function", function: { name: "agenda_horarios_livres", arguments: "{}" } });
const tool = (id: string): ChatMessage => ({ role: "tool", tool_call_id: id, content: `{"ok":true,"id":"${id}"}` });

describe("ordem das mensagens de ferramenta", () => {
  it("histórico em ordem volta como está (a mesma lista)", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "Deixa eu ver.", tool_calls: [call("c1")] },
      tool("c1"),
      { role: "assistant", content: "Tem sexta." },
      { role: "user", content: "pode ser" },
    ];
    expect(repairToolOrder(messages)).toBe(messages);
  });

  it("o caso da ligação de 25/11: fala do assistente entre a chamada e o resultado entra no texto da chamada", () => {
    const repaired = repairToolOrder([
      { role: "user", content: "marca amanhã às cinco" },
      { role: "assistant", content: "Deixa eu checar a agenda pra amanhã às cinco.", tool_calls: [call("c1")] },
      { role: "assistant", content: "Um instante, estou conferindo a agenda." },
      tool("c1"),
      { role: "user", content: "Tem como?" },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: "marca amanhã às cinco" },
      { role: "assistant", content: "Deixa eu checar a agenda pra amanhã às cinco. Um instante, estou conferindo a agenda.", tool_calls: [call("c1")] },
      tool("c1"),
      { role: "user", content: "Tem como?" },
    ]);
  });

  it("fala da pessoa no meio vai para depois dos resultados, na ordem, e chamadas em paralelo ficam juntas", () => {
    const repaired = repairToolOrder([
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      tool("a"),
      { role: "user", content: "alô?" },
      { role: "assistant", content: "Um instante." },
      tool("b"),
      { role: "user", content: "tá aí?" },
    ]);
    expect(repaired.map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}` : m.role))).toEqual(["assistant", "tool:a", "tool:b", "user", "user"]);
    expect(repaired[0]).toMatchObject({ content: "Um instante." });
    expect(repaired.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["alô?", "tá aí?"]);
  });

  it("resultado que ainda não chegou (a ferramenta roda): não mexe", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: null, tool_calls: [call("c1")] }, { role: "assistant", content: "Um instante." }];
    expect(repairToolOrder(messages)).toBe(messages);
  });
});
