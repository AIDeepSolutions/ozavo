-- A manutenção diária das gravações lia todas as chamadas da organização e consultava o S3 para
-- cada uma, todo dia: o custo crescia com o acervo. Agora a chamada guarda quando a gravação foi
-- copiada e quando a cópia remota foi apagada, e a manutenção só olha o que ainda falta.
-- Uma restauração de banco antiga só faz a manutenção repetir trabalho (copiar ou apagar de novo),
-- nunca pular uma exclusão.
alter table calls add column recording_archived_at timestamptz,
  add column recording_remote_purged_at timestamptz;
create index calls_recording_remote_pending_idx on calls (organization_id, ended_at)
  where recording_remote_purged_at is null;
