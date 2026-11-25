-- Base de conhecimento (RAG) do agente de voz. Cada empresa envia documentos (PDF, DOCX, Markdown,
-- texto ou texto colado); uma rotina em segundo plano extrai o texto, parte em trechos de ~250 a 400
-- tokens, gera o embedding de cada trecho pelo OpenRouter e grava aqui. Na ligação, o agente busca
-- por similaridade (pgvector) e por palavras (busca textual) só nas bases que lhe foram atribuídas.
--
-- Decisões (docs/decisions/0022-base-de-conhecimento.md):
--   * `vector(1536)` é o tamanho do `openai/text-embedding-3-small`; o modelo fica registrado por
--     versão, e trocar de modelo de outro tamanho pede uma migration nova.
--   * Sem índice HNSW por enquanto: a busca é exata, filtrada pelas fontes do agente (índice por
--     fonte), que é o que dá resultado completo quando o filtro é seletivo. Com HNSW o filtro depois
--     do índice devolveria menos trechos que o pedido. Entra quando uma empresa passar de ~50 mil trechos.
--   * Versões: reindexar ou trocar o arquivo cria uma versão nova; os trechos da anterior só saem
--     quando a nova está pronta e a fonte aponta para ela (`current_version_id`).
--   * O arquivo enviado (`raw`) vive só até a extração; o texto extraído fica (`content_text`).
--   * Vale para quem instala por conta própria: a extensão `vector` precisa existir no Postgres. A
--     imagem do Compose passa a ser a do pgvector (deploy/docker-compose.yml); no Supabase a
--     extensão já é oferecida e esta migration a liga.

create extension if not exists vector with schema public;

create table knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null check (char_length(name) between 1 and 200),
  kind text not null check (kind in ('pdf', 'docx', 'md', 'txt', 'text')),
  original_filename text check (char_length(original_filename) <= 255),
  -- O estado da versão mais recente (a que está sendo ou foi indexada). A fonte com versão corrente
  -- continua respondendo enquanto uma nova indexa: `current_version_id` não muda até ela ficar pronta.
  status text not null default 'queued' check (status in ('queued', 'processing', 'ready', 'failed')),
  -- Vocabulário fechado em packages/core (`KNOWLEDGE_ERROR_CODES`); nunca texto do documento.
  error_code text,
  current_version_id uuid,
  -- Números da versão corrente.
  size_bytes bigint not null default 0,
  token_count integer not null default 0,
  chunk_count integer not null default 0,
  embedding_model text not null,
  -- Tudo o que a indexação desta fonte já custou, de todas as versões, em microcentavos de dólar.
  index_cost_microcents bigint not null default 0,
  created_by uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  indexed_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, created_by) references users (organization_id, id) on delete set null (created_by)
);
create index knowledge_sources_org_idx on knowledge_sources (organization_id, created_at desc);
create index knowledge_sources_created_by_idx on knowledge_sources (organization_id, created_by);

create table knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  source_id uuid not null,
  version integer not null check (version >= 1),
  status text not null default 'queued' check (status in ('queued', 'processing', 'ready', 'failed', 'superseded')),
  error_code text,
  -- O arquivo como foi enviado, só até a extração; depois fica nulo.
  raw bytea,
  -- O texto extraído: é o que a base inteira no prompt usa e o que a reindexação reaproveita.
  content_text text,
  size_bytes bigint not null default 0,
  token_count integer not null default 0,
  chunk_count integer not null default 0,
  embedding_model text not null,
  embedding_tokens integer not null default 0,
  cost_microcents bigint not null default 0,
  created_by uuid,
  created_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  unique (organization_id, id),
  unique (source_id, version),
  foreign key (organization_id, source_id) references knowledge_sources (organization_id, id) on delete cascade,
  foreign key (organization_id, created_by) references users (organization_id, id) on delete set null (created_by)
);
create index knowledge_versions_source_idx on knowledge_versions (organization_id, source_id, version desc);
create index knowledge_versions_created_by_idx on knowledge_versions (organization_id, created_by);

alter table knowledge_sources
  add foreign key (organization_id, current_version_id) references knowledge_versions (organization_id, id) on delete set null (current_version_id);
create index knowledge_sources_current_version_idx on knowledge_sources (organization_id, current_version_id);

create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  source_id uuid not null,
  version_id uuid not null,
  position integer not null check (position >= 0),
  -- O título da seção em que o trecho está, quando o documento tem títulos.
  section text,
  content text not null,
  token_count integer not null check (token_count > 0),
  -- O mesmo texto sem acento e em minúsculas, para a busca por palavras (`packages/core/src/knowledge.ts`).
  search_text text not null,
  embedding vector(1536) not null,
  tsv tsvector generated always as (to_tsvector('portuguese', search_text)) stored,
  created_at timestamptz not null,
  unique (version_id, position),
  foreign key (organization_id, version_id) references knowledge_versions (organization_id, id) on delete cascade,
  foreign key (organization_id, source_id) references knowledge_sources (organization_id, id) on delete cascade
);
create index knowledge_chunks_source_idx on knowledge_chunks (organization_id, source_id, version_id);
create index knowledge_chunks_version_idx on knowledge_chunks (organization_id, version_id);
create index knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);

-- Quais bases cada agente usa: um agente pode ter várias; uma base pode servir vários agentes.
create table agent_knowledge_sources (
  organization_id uuid not null references organizations (id),
  agent_id uuid not null,
  source_id uuid not null,
  created_at timestamptz not null,
  primary key (agent_id, source_id),
  foreign key (organization_id, agent_id) references agents (organization_id, id) on delete cascade,
  foreign key (organization_id, source_id) references knowledge_sources (organization_id, id) on delete cascade
);
create index agent_knowledge_sources_source_idx on agent_knowledge_sources (organization_id, source_id);

-- O que a base custou além do que cabe no extrato da ligação: a indexação (sem ligação) e a busca de
-- teste feita na tela. O embedding da pergunta DURANTE a ligação vai no extrato da própria ligação
-- (`usage_ledger`), para o custo por minuto já incluí-lo. Microcentavos de dólar, como o extrato.
create table knowledge_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  source_id uuid,
  version_id uuid,
  kind text not null check (kind in ('index', 'search')),
  model text not null,
  tokens integer not null default 0 check (tokens >= 0),
  cost_microcents bigint not null default 0 check (cost_microcents >= 0),
  at timestamptz not null,
  foreign key (organization_id, source_id) references knowledge_sources (organization_id, id) on delete set null (source_id),
  foreign key (organization_id, version_id) references knowledge_versions (organization_id, id) on delete set null (version_id)
);
create index knowledge_usage_org_at_idx on knowledge_usage (organization_id, at);
create index knowledge_usage_source_idx on knowledge_usage (organization_id, source_id);
create index knowledge_usage_version_idx on knowledge_usage (organization_id, version_id);

-- Como o agente usa as bases. `auto` escolhe pelo tamanho; `rag` busca por pergunta; `full` põe a base
-- inteira no prompt (cacheável). `knowledge_only`: responder só pelo que está nas bases.
alter table agents
  add column knowledge_mode text not null default 'auto' check (knowledge_mode in ('auto', 'rag', 'full')),
  add column knowledge_only boolean not null default false;

-- Mesmo isolamento das tabelas da fundação.
do $$
declare
  t text;
begin
  foreach t in array array['knowledge_sources', 'knowledge_versions', 'knowledge_chunks', 'agent_knowledge_sources', 'knowledge_usage']
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
