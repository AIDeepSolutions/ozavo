-- Ligação de saída pedida por um sistema de fora (`POST /api/v1/calls/outbound` com chave de API).
-- A chamada guarda qual chave pediu, o contexto que veio junto (o lead, o motivo) e a chave de
-- repetição: o mesmo pedido reenviado devolve a mesma chamada, em vez de ligar duas vezes.

alter table calls add column requested_by_key_id uuid;
alter table calls add constraint calls_api_key_fk
  foreign key (organization_id, requested_by_key_id) references api_keys (organization_id, id) on delete set null (requested_by_key_id);
-- Dado que o agente lê como contexto da ligação, nunca como instrução. Teto de 8 KB.
alter table calls add column request_context jsonb check (request_context is null or octet_length(request_context::text) <= 8192);
alter table calls add column request_key text check (char_length(request_key) between 1 and 200);

create unique index calls_request_key_idx on calls (organization_id, request_key) where request_key is not null;
create index calls_requested_by_key_idx on calls (organization_id, requested_by_key_id);
