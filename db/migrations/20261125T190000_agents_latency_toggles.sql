-- Ajustes de latência do agente em pipeline (ADR 0023), escolhidos na tela do agente. Ambos nascem LIGADOS:
--   latency_bridge:       frase curta pré-gravada com a voz do agente quando o modelo demora para o primeiro texto;
--   latency_speculation:  o pedido ao modelo sai antes de o fim de turno estar decidido, e é descartado se a pessoa continuar.
-- Só o motor em pipeline os usa; os motores de voz direta ignoram as colunas.
alter table agents
  add column latency_bridge boolean not null default true,
  add column latency_speculation boolean not null default true;
