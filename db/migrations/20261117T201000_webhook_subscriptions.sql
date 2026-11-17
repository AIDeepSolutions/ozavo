-- Webhooks universais por empresa (MT-12). Cada empresa cadastra os destinos que recebem os fatos
-- da própria operação: fim de chamada, desfecho, alerta de franquia e redução de cadência. O
-- segredo que assina cada entrega é gerado pelo servidor, mostrado uma vez e guardado cifrado
-- (`encryptSecret`); nenhuma leitura devolve a coluna `secret_enc`.
--
-- Esta migration também abre o escopo `hooks:inbound` das chaves de API, que autoriza
-- `POST /api/v1/hooks/[slug]`.

create table webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  -- Só https; a validação completa (endereço público) é de `packages/core/src/webhooks.ts`, na
  -- criação e de novo a cada entrega.
  url text not null check (char_length(url) between 9 and 2000 and url like 'https://%'),
  -- Vocabulário fechado em packages/core (`WEBHOOK_EVENTS`).
  events text[] not null check (cardinality(events) >= 1 and events <@ array['call.ended', 'call.outcome', 'usage.alert', 'cadence.reduced']::text[]),
  secret_enc text not null,
  enabled boolean not null default true,
  created_by uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  secret_rotated_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, created_by) references users (organization_id, id) on delete set null (created_by)
);
create index webhook_subscriptions_org_idx on webhook_subscriptions (organization_id, created_at desc);
create index webhook_subscriptions_created_by_idx on webhook_subscriptions (organization_id, created_by);

-- Mesmo isolamento das tabelas da fundação.
alter table webhook_subscriptions enable row level security;
alter table webhook_subscriptions force row level security;
create policy organization_isolation on webhook_subscriptions
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on webhook_subscriptions to ozavo_app, ozavo_system;

-- Escopo novo das chaves de API.
alter table api_keys drop constraint api_keys_scopes_check;
alter table api_keys add constraint api_keys_scopes_check
  check (cardinality(scopes) >= 1 and scopes <@ array['calls:outbound', 'tenants:provision', 'hooks:inbound']::text[]);
