-- Identidade apresentada pela linha da própria organização. Nunca é voz biométrica.
alter table trunks add column caller_display_name text,
  add column rcd_logo_png bytea;
alter table trunks add constraint trunks_display_name_ascii check (
  caller_display_name is null or (length(caller_display_name) between 1 and 32
    and caller_display_name ~ '^[A-Za-z0-9 .&()+_/-]+$')),
  add constraint trunks_rcd_logo_size check (rcd_logo_png is null or octet_length(rcd_logo_png) <= 307200);

-- Linhas já instaladas não mudam de protocolo sem homologação da operadora.
-- Na composição Supabase só há transporte TLS: linha legada precisa ser convertida pela tela.
alter table trunks add column sip_tls boolean not null default false;
alter table trunks alter column sip_tls set default true;
