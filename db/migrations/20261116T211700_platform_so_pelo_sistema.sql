-- `organizations.platform` decide quem provisiona empresas e troca planos e limites. Até aqui só o
-- código impedia uma empresa cliente de se marcar como plataforma: o papel de aplicação tem UPDATE
-- na tabela inteira. Agora o banco recusa. Gatilho, e não GRANT por coluna, para que uma coluna
-- nova em `organizations` não precise lembrar de um GRANT.
-- O `create-owner` liga a coluna pelo papel de sistema (`withSystem`), que segue podendo.
create function organizations_platform_guard() returns trigger
language plpgsql as $$
begin
  if current_user = 'ozavo_app' and (tg_op = 'INSERT' and new.platform or tg_op = 'UPDATE' and new.platform is distinct from old.platform) then
    raise exception 'organizations.platform is set only by the system role'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create trigger organizations_platform_guard
  before insert or update of platform on organizations
  for each row execute function organizations_platform_guard();
