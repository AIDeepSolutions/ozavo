-- O provisionamento pela API deixa de devolver a senha do dono no corpo da resposta (que passava
-- pelo n8n e pelos logs de quem o chamou). Em vez disso, a empresa nasce sem usuário e com um
-- convite de dono de uso único: a pessoa abre o link e escolhe a própria senha.
-- O convite provisionado não tem criador na equipe (a empresa ainda não tem ninguém). Ele vale só
-- enquanto a empresa não tem dono ativo: aceito o primeiro, qualquer outro convite provisionado
-- deixa de valer. A regra mora em `packages/core/src/invites.ts`.
alter table invites add column provisioned boolean not null default false;
alter table invites add constraint invites_provisioned_is_owner check (not provisioned or (role = 'owner' and created_by is null));
