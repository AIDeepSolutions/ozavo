-- Linha nova nasce em UDP, como a maioria das operadoras fala. O TLS na porta 5061 com SRTP
-- continua a um clique na tela (e é a escolha da produção que homologa com a operadora), mas não
-- é mais o padrão silencioso: na instalação comunitária, a linha cadastrada com o padrão não
-- registrava em operadora só UDP (auditoria de 16/11/2026, item 7). As linhas existentes ficam
-- como estão.
alter table trunks alter column sip_tls set default false;
