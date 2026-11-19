-- Perfil do modelo de texto do agente (motor em pipeline), escolhido na tela do agente. Valores:
--   'a' qualidade primeiro (padrão): Claude Haiku 5.5, cache do prompt, teto de saída 1024, raciocínio padrão;
--   'b' telefonia: Haiku 5.5, raciocínio desligado e horários livres agrupados por dia;
--   'c' Gemini 2.5 Flash, como antes do benchmark R2.
-- Definição e medidas: packages/voice-engine/src/pipeline/llm-profile.ts e no ramo `feat/benchmark-llm-2` (`docs/benchmark-llm-r2/`).
-- Padrão 'a': agente que já existia passa a usar o perfil A quando o motor é o pipeline (os motores de voz direta ignoram a
-- coluna). Quem quiser o comportamento de antes escolhe 'c' na tela do agente.
alter table agents
  add column llm_profile text not null default 'a'
    check (llm_profile in ('a', 'b', 'c'));
