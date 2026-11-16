-- Plano contratado e medição da franquia (Fase 3: 3.1 e 3.2).
--
-- `plan_subscriptions` é o plano de UMA organização. O catálogo (Starter, Pro, Growth, Scale) mora
-- no código (`PLAN_CATALOG`, em packages/core): a linha guarda a cópia dos valores em vigor, e é o
-- que deixa o plano Personalizado existir sem tabela à parte. Organização sem linha não tem plano:
-- nada é limitado nem alertado, que é o comportamento de toda instalação anterior a esta migration.
--
-- Dinheiro em centavos de real. O ciclo é mensal e começa no dia de `cycle_started_on`.

create table plan_subscriptions (
  organization_id uuid primary key references organizations (id),
  plan text not null check (plan in ('starter', 'pro', 'growth', 'scale', 'custom')),
  monthly_price_cents integer not null check (monthly_price_cents >= 0),
  included_minutes integer not null check (included_minutes >= 0),
  -- O que acontece quando a franquia acaba: as ligações de saída param, ou continuam e o excedente
  -- é tarifado por minuto. Ligação recebida nunca é recusada por franquia.
  overage_rule text not null default 'pause_outbound' check (overage_rule in ('pause_outbound', 'bill_overage')),
  overage_price_cents_per_minute integer not null default 0 check (overage_price_cents_per_minute >= 0),
  max_concurrent_calls integer not null check (max_concurrent_calls between 1 and 500),
  cycle_started_on date not null,
  updated_at timestamptz not null
);

-- Um alerta por limiar e por ciclo: a chave única é o que impede o mesmo aviso de sair duas vezes
-- quando duas chamadas medem ao mesmo tempo.
create table usage_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  period_start date not null,
  threshold integer not null check (threshold in (80, 100)),
  consumed_seconds integer not null check (consumed_seconds >= 0),
  included_seconds integer not null check (included_seconds >= 0),
  at timestamptz not null,
  unique (organization_id, period_start, threshold)
);

-- O extrato passa a dizer quantos caracteres a síntese de voz gerou em cada linha: é a unidade que
-- o provedor de síntese cobra, e o painel de FinOps a soma. O que já está gravado fica em zero,
-- porque o número não foi guardado na época.
alter table usage_ledger
  add column tts_characters integer not null default 0 check (tts_characters >= 0);

comment on column usage_ledger.tts_characters is
  'Caracteres mandados à síntese de voz nesta linha do extrato. Zero nos motores de voz direta.';

-- Mesmo isolamento das tabelas da fundação.
do $$
declare
  t text;
begin
  foreach t in array array['plan_subscriptions', 'usage_alerts']
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
