// dono: @DeskLabs-OpenSource/maintainers
// motivo: no Coolify não há Caddy, e o Compose da voz não roteava `/voice-ws`: o painel devolvia 404
//   ao WebSocket e "Falar com o agente" ficava em "Conectando" até a chamada fechar por
//   `web_never_connected`. Esta cerca exige que o Compose da voz mande `/voice-ws` à porta 8091.
// revisar em: 2027-05-25
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT, asRecord, read } from "./_lib";

const COMPOSE = "deploy/docker-compose.coolify-voz.yml";

export function check(root: string): string[] {
  const voice = asRecord(asRecord(asRecord(parse(read(root, COMPOSE))).services).voice);
  const labels = Array.isArray(voice.labels) ? voice.labels.map(String) : [];
  const violations: string[] = [];
  if (!labels.some((l) => /\.rule=.*PathPrefix\(`\/voice-ws`\)/.test(l))) violations.push(`${COMPOSE}: a voz não tem rota Traefik para /voice-ws`);
  if (!labels.some((l) => /\.loadbalancer\.server\.port=8091$/.test(l))) violations.push(`${COMPOSE}: a rota de /voice-ws não aponta para a porta 8091`);
  return violations;
}

describe("o Compose da voz no Coolify roteia /voice-ws", () => {
  it("o repositório tem a rota", () => expect(check(REPO_ROOT)).toEqual([]));
});
