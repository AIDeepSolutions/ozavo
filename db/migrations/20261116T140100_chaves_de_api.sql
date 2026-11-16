-- Chaves de API: o que autentica um sistema de fora (o n8n, um CRM) no lugar de uma pessoa. A
-- chave pertence a uma organização e só faz o que o escopo dela diz. O banco guarda só o resumo
-- (`key_hash`) e o começo da chave, para a tela mostrar qual é qual; a chave em claro aparece uma
-- vez, ao ser criada.

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null check (char_length(name) between 1 and 60),
  key_prefix text not null check (char_length(key_prefix) between 4 and 20),
  -- Único na instalação: a chave é achada pelo resumo antes de se saber a organização.
  key_hash text not null unique,
  -- Vocabulário fechado em packages/core (`API_KEY_SCOPES`).
  scopes text[] not null check (cardinality(scopes) >= 1 and scopes <@ array['calls:outbound', 'tenants:provision']::text[]),
  created_by uuid,
  created_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, created_by) references users (organization_id, id) on delete set null (created_by)
);
create index api_keys_org_idx on api_keys (organization_id, created_at desc);
create index api_keys_created_by_idx on api_keys (organization_id, created_by);

-- Mesmo isolamento das tabelas da fundação.
alter table api_keys enable row level security;
alter table api_keys force row level security;
create policy organization_isolation on api_keys
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on api_keys to ozavo_app, ozavo_system;
