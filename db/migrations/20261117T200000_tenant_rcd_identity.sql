-- Identidade RCD (nome e logo apresentados ao chamado) no cadastro da empresa. As linhas da empresa
-- herdam estes valores quando não têm os próprios (`trunks.caller_display_name`, `trunks.rcd_logo_png`);
-- o valor próprio da linha sobrescreve. O envio à operadora não é feito aqui.
-- O nome é ASCII seguro em CAIXA ALTA, com até 32 caracteres; o logo vem do conversor do core, em PNG
-- e em BMP 256x256 com alfa, cada um com até 300 KB.
alter table tenant_profiles
  add column rcd_display_name text,
  add column rcd_logo_png bytea,
  add column rcd_logo_bmp bytea;
alter table tenant_profiles
  add constraint tenant_profiles_rcd_name_ascii check (
    rcd_display_name is null or (length(rcd_display_name) between 1 and 32
      and rcd_display_name ~ '^[A-Z0-9 .&()+_/-]+$')),
  add constraint tenant_profiles_rcd_logo_png_size check (rcd_logo_png is null or octet_length(rcd_logo_png) <= 307200),
  add constraint tenant_profiles_rcd_logo_bmp_size check (rcd_logo_bmp is null or octet_length(rcd_logo_bmp) <= 307200);
