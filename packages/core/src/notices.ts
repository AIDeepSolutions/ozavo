import { enqueueTask } from "./queue";
import type { OrgQuery } from "./types";

/**
 * Deixa um aviso no painel da organização, fora de uma chamada, e enfileira a entrega. Mesmo
 * formato do aviso que o processo de voz grava quando uma chamada falha: é por aqui que um
 * alerta de franquia ou de cadência chega a quem opera.
 */
export async function notifyPanel(q: OrgQuery, body: string, at: Date): Promise<void> {
  const row = await q.one<{ id: string }>(
    "insert into notifications (organization_id, call_id, channel, target, body, created_at) values ($1, null, 'panel', null, $2, $3) returning id",
    [q.organizationId, body, at],
  );
  if (!row) throw new Error("Panel notification was not created");
  await enqueueTask(q, { kind: "deliver_notification", payload: { notificationId: row.id }, runAt: at });
}
