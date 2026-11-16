-- Perfil da empresa (o "tenant" da especificação do Ozavo). O isolamento já existe: tenant é a
-- organização, e toda tabela já tem `organization_id` com RLS. Aqui entram os dados que faltavam
-- por empresa: os societários, a persona padrão do agente, a voz padrão, o prompt base, o plano
-- contratado e o vínculo com quem a provisionou (a assinatura no Asaas, pelo n8n).

-- A organização que administra a instalação: só ela emite chave de API com o escopo de provisionar
-- empresas. Numa instalação que já existia, é a primeira organização criada; numa nova, é a que o
-- `create-owner` cria primeiro. Nunca é ligada pela API.
alter table organizations add column platform boolean not null default false;
update organizations set platform = true
 where id = (select id from organizations order by created_at, id limit 1)
   and not exists (select from organizations where platform);

create table tenant_profiles (
  organization_id uuid primary key references organizations (id),
  -- Razão social, CNPJ (só dígitos) e nome fantasia.
  legal_name text check (char_length(legal_name) between 1 and 200),
  cnpj text check (cnpj ~ '^[0-9]{14}$'),
  trade_name text check (char_length(trade_name) between 1 and 200),
  -- O nome com que o agente se apresenta quando o agente não tem nome próprio nas instruções.
  persona_name text not null default 'Nico' check (char_length(persona_name) between 1 and 60),
  -- A voz da empresa (o `voice_id` do provedor de voz, como a Cartesia o publica). Vale quando o
  -- agente não escolheu a dele.
  default_voice_id text check (char_length(default_voice_id) between 1 and 200),
  -- Instrução que vem antes da instrução de cada agente da empresa: tom, o que nunca dizer, dados
  -- fixos do negócio. Vazia, o agente recebe só a dele, como antes.
  base_prompt text not null default '' check (char_length(base_prompt) <= 8000),
  -- O agente que atende o disparo pela API quando o pedido não diz qual.
  default_agent_id uuid,
  -- O plano contratado e a franquia mensal, gravados pelo provisionamento. O motor de planos
  -- (fase 3) é quem lê e cobra; aqui é só o vínculo.
  plan_code text check (plan_code ~ '^[a-z][a-z0-9_-]{0,39}$'),
  monthly_minutes integer check (monthly_minutes >= 0),
  -- Suspensa: as chaves de API da empresa deixam de valer.
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- Quem pediu o provisionamento e com que referência (a assinatura no Asaas). Repetir o pedido
  -- com a mesma referência devolve a mesma empresa: o n8n pode reenviar sem criar duas.
  external_source text check (external_source ~ '^[a-z][a-z0-9_-]{0,39}$'),
  external_ref text check (char_length(external_ref) between 1 and 200),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (organization_id, default_agent_id) references agents (organization_id, id) on delete set null (default_agent_id)
);
-- Única na instalação: é a chave de idempotência do provisionamento, que acontece antes de existir
-- a organização.
create unique index tenant_profiles_external_idx on tenant_profiles (external_source, external_ref) where external_ref is not null;
create index tenant_profiles_default_agent_idx on tenant_profiles (organization_id, default_agent_id);

-- Mesmo isolamento das tabelas da fundação.
alter table tenant_profiles enable row level security;
alter table tenant_profiles force row level security;
create policy organization_isolation on tenant_profiles
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
grant select, insert, update, delete on tenant_profiles to ozavo_app, ozavo_system;
