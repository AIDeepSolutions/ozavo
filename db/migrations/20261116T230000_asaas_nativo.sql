-- Integração nativa: caixa de entrada durável, vínculo da assinatura e estado por pagamento.
create table asaas_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  environment text not null check (environment in ('sandbox', 'production')),
  event_id text not null,
  event_kind text not null,
  payload jsonb not null,
  received_at timestamptz not null,
  processed_at timestamptz,
  unique (organization_id, environment, event_id)
);
create table asaas_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  environment text not null check (environment in ('sandbox', 'production')),
  subscription_id text not null,
  tenant_id uuid references organizations(id),
  cancelled boolean not null default false,
  revision integer not null default 0,
  inactive boolean not null default false,
  subscription_event_at text not null default '',
  owner_invite_enc text,
  owner_invite_expires_at timestamptz,
  unique (organization_id, environment, subscription_id)
);
create table asaas_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  environment text not null check (environment in ('sandbox', 'production')),
  subscription_id text not null,
  payment_id text not null,
  status text not null check (status in ('paid', 'overdue', 'refunded')),
  unique (organization_id, environment, payment_id)
);
alter table asaas_events enable row level security;
alter table asaas_events force row level security;
create policy organization_isolation on asaas_events
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on asaas_events to ozavo_app, ozavo_system;
alter table asaas_subscriptions enable row level security;
alter table asaas_subscriptions force row level security;
create policy organization_isolation on asaas_subscriptions
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on asaas_subscriptions to ozavo_app, ozavo_system;
alter table asaas_payments enable row level security;
alter table asaas_payments force row level security;
create policy organization_isolation on asaas_payments
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on asaas_payments to ozavo_app, ozavo_system;
