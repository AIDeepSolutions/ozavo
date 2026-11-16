-- A regra do disjuntor de chamadas curtas passa a ser configurável pela tela (FinOps → Limites de
-- operação, só a plataforma), com o padrão da especificação do produto (seção 6, Despacho 100/2026
-- da Anatel citado por ela): ligações com duração INFERIOR a 6 segundos. O texto do despacho não
-- foi conferido; por isso a fronteira e o que conta como curta ficam ajustáveis, sem inventar regra.
alter table operation_settings
  -- Segundos abaixo dos quais a ligação é curta.
  add column short_call_seconds integer not null default 6 check (short_call_seconds between 1 and 60),
  -- Verdadeiro: a ligação de exatamente `short_call_seconds` também é curta (fronteira "até", ≤).
  add column short_call_inclusive boolean not null default false,
  -- Verdadeiro: a ligação de saída não completada (sem atendimento) conta como curta, com duração 0.
  add column short_call_counts_unanswered boolean not null default true;
