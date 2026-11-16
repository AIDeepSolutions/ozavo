-- Limites de operação e redução de cadência (Fase 3: 3.3, 3.5 e 3.6).
--
-- `operation_settings` é o que quem opera escolhe pela tela, por organização. Tudo aceita nulo, e
-- nulo é "não informado": sem teto do provedor de síntese não há limite por ele, e sem cotação ou
-- custo de telefonia o painel de FinOps diz que falta o dado em vez de inventar um.

create table operation_settings (
  organization_id uuid primary key references organizations (id),
  -- Chamadas simultâneas que a conta do provedor de síntese aceita (o teto do plano contratado lá).
  tts_concurrency_limit integer check (tts_concurrency_limit between 1 and 1000),
  -- Ligações de saída por hora, por linha, enquanto a cadência está reduzida.
  reduced_calls_per_hour integer not null default 60 check (reduced_calls_per_hour between 1 and 10000),
  -- Custo de telefonia em reais por minuto falado.
  telephony_brl_per_minute numeric(10, 4) check (telephony_brl_per_minute >= 0),
  -- Cotação do dólar em reais, para converter o custo dos provedores (medido em dólar).
  usd_brl_rate numeric(10, 4) check (usd_brl_rate > 0),
  updated_at timestamptz not null
);

-- Uma linha por linha telefônica e por dia em que a proporção de chamadas curtas passou do limite.
-- Enquanto a linha do dia existe, as ligações de saída daquela linha telefônica saem na cadência
-- reduzida. `line_e164` vazio é a organização inteira (chamadas sem número de origem).
create table cadence_breakers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  line_e164 text not null default '',
  day date not null,
  total_calls integer not null check (total_calls >= 0),
  short_calls integer not null check (short_calls >= 0),
  tripped_at timestamptz not null,
  unique (organization_id, line_e164, day)
);

-- A contagem do dia lê as ligações de saída pela data de início.
create index calls_outbound_started_idx on calls (organization_id, started_at) where direction = 'outbound';

-- Mesmo isolamento das tabelas da fundação.
do $$
declare
  t text;
begin
  foreach t in array array['operation_settings', 'cadence_breakers']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy organization_isolation on %I
         using (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)
         with check (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      t);
    execute format('grant select, insert, update, delete on %I to ozavo_app, ozavo_system', t);
  end loop;
end $$;
