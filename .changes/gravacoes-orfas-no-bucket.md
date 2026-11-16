---
impact: operator_action
section: added
title: A manutenção das gravações apaga do bucket a cópia que o banco não sustenta
---

Quem usa cópia remota das gravações (S3 ou MinIO) passa a ter, uma vez por semana por organização, uma varredura do bucket: sai a cópia de chamada vencida ou apagada a pedido do titular, inclusive quando o banco foi restaurado de um backup mais antigo que o bucket, e a cópia sem chamada nenhuma depois do prazo de guarda. O registro de privacidade mostra quantas cópias saíram. O MinIO interno já permite tudo o que a varredura usa. Crédito: @AIDeepSolutions.

## Requer atenção

Se a cópia remota usa um S3 externo, dê à credencial também a permissão de listar o bucket (`s3:ListBucket`) antes de atualizar. Sem ela, a manutenção das gravações falha no dia da varredura e a fila tenta de novo, sem apagar a cópia órfã.
