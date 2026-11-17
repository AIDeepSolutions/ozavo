---
impact: new_capability
section: added
title: Nome e logo RCD no cadastro da empresa
---

A plataforma passa a definir, no detalhe de cada empresa em /platform, o nome RCD (em CAIXA ALTA, sem acento, até 32 caracteres ASCII) e o logo RCD, convertido para PNG e BMP 256×256 com transparência, até 300 KB cada. As linhas da empresa usam esses valores quando não têm os próprios; o valor da linha continua valendo. O provisionamento por API e a criação pela tela aceitam o nome RCD. Trocar ou remover o logo pede confirmação com o nome da empresa e fica na linha do tempo. O envio à operadora não faz parte desta mudança. **Quem já instalou precisa aplicar a migration `20261117T200000_tenant_rcd_identity.sql` à mão**, pois o deploy não aplica migrations. Crédito: @AIDeepSolutions.
