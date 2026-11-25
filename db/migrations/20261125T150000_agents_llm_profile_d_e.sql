-- Perfis 'd' e 'e' do modelo de texto do agente: 'd' gpt-oss-120b (Cerebras, Groq, BaseTen) e 'e' DeepSeek V4.1 Flash (Together), para teste ao vivo lado a
-- lado com o perfil 'b'. Definição em packages/voice-engine/src/pipeline/llm-profile.ts; bancada em
-- docs/reports/2026-11-25-llm-rapido.md. Só amplia o conjunto aceito: nenhuma linha existente muda.
alter table agents drop constraint agents_llm_profile_check;
alter table agents add constraint agents_llm_profile_check check (llm_profile in ('a', 'b', 'c', 'd', 'e'));
