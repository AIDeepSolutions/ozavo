import { z } from "zod";
import { recordOrgEvent } from "./events";
import { notifyPanel } from "./notices";
import { enqueueTask } from "./queue";
import type { Db, OrgQuery } from "./types";
import { withSystem } from "./with-org";

/**
 * Os alertas críticos de uma empresa cliente também chegam à organização que administra a
 * instalação (especificação, seção 6: "emite alerta crítico no painel Admin"): franquia em 80% e
 * 100% e o disjuntor de chamadas curtas.
 *
 * A empresa grava o alerta na própria transação, pelo papel de aplicação, e no mesmo commit põe na
 * fila uma tarefa `mirror_alert_to_platform` na organização dela. A rotina chama
 * `mirrorAlertToPlatform`, que atravessa organizações pelo papel de sistema só para escrever o aviso
 * e o evento na plataforma. Se a tarefa repetir, a chave do alerta impede o aviso dobrado.
 *
 * O texto leva só o nome da empresa e números de consumo: nenhum dado de quem ligou.
 */
export const MIRROR_ALERT_TASK = "mirror_alert_to_platform";

export const platformAlertPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("usage"),
    threshold: z.number().int(),
    periodStart: z.string(),
    consumedSeconds: z.number().int().min(0),
    includedSeconds: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("breaker"),
    lineE164: z.string(),
    totalCalls: z.number().int().min(0),
    shortCalls: z.number().int().min(0),
    reducedCallsPerHour: z.number().int().min(0),
    day: z.string(),
  }),
]);
export type PlatformAlertPayload = z.infer<typeof platformAlertPayload>;

/** Na transação da empresa, junto com o alerta dela. */
export async function queuePlatformAlert(q: OrgQuery, alert: PlatformAlertPayload, now: Date): Promise<void> {
  await enqueueTask(q, { kind: MIRROR_ALERT_TASK, payload: alert, runAt: now });
}

/** A mesma chave para o mesmo alerta: um por limiar e ciclo, um por linha e dia. */
export function alertKey(alert: PlatformAlertPayload): string {
  return alert.kind === "usage" ? `usage:${alert.periodStart}:${alert.threshold}` : `breaker:${alert.day}:${alert.lineE164}`;
}

const minutes = (seconds: number): number => Math.ceil(seconds / 60);

export function platformAlertBody(tenantName: string, alert: PlatformAlertPayload): string {
  if (alert.kind === "usage") {
    const used = `${minutes(alert.consumedSeconds)} de ${minutes(alert.includedSeconds)} minutos`;
    return alert.threshold >= 100
      ? `ALERTA CRÍTICO: ${tenantName} esgotou a franquia do plano (${used} neste ciclo). O detalhe está em Empresas e em FinOps das empresas.`
      : `${tenantName} chegou a ${alert.threshold}% da franquia do plano (${used} neste ciclo). O detalhe está em Empresas e em FinOps das empresas.`;
  }
  const percent = alert.totalCalls > 0 ? Math.round((alert.shortCalls / alert.totalCalls) * 100) : 0;
  const where = alert.lineE164 === "*" ? "somando todas as linhas" : alert.lineE164 === "" ? "na organização" : `na linha ${alert.lineE164}`;
  return (
    `ALERTA CRÍTICO: ${tenantName} fez ${alert.totalCalls} ligações de saída hoje ${where}, e ${percent}% foram curtas. ` +
    `O disjuntor reduziu a cadência para ${alert.reducedCallsPerHour} ligações por hora até o fim do dia, para evitar o bloqueio do número.`
  );
}

/**
 * Escreve o alerta da empresa `tenantId` em cada organização da plataforma: aviso no painel e evento
 * `tenant_critical_alert`. Devolve quantas plataformas receberam agora (zero se já tinham recebido,
 * se a empresa não existe ou se o alerta é da própria plataforma, que já foi avisada na origem).
 */
export function mirrorAlertToPlatform(db: Db, tenantId: string, alert: PlatformAlertPayload, now: Date): Promise<number> {
  return withSystem(db, async (q) => {
    const tenant = await q.one<{ name: string; platform: boolean }>("select name, platform from organizations where id = $1", [tenantId]);
    if (!tenant || tenant.platform) return 0;
    const key = alertKey(alert);
    const platforms = await q.many<{ id: string }>("select id from organizations where platform order by id");
    let delivered = 0;
    for (const platform of platforms) {
      // Serializa duas entregas da mesma tarefa: a segunda espera a primeira e vê o evento.
      await q.exec("select pg_advisory_xact_lock(hashtext($1))", [`${platform.id}:${tenantId}:${key}`]);
      const seen = await q.one(
        "select 1 as hit from organization_events where organization_id = $1 and kind = 'tenant_critical_alert' and payload->>'tenantId' = $2 and payload->>'alertKey' = $3",
        [platform.id, tenantId, key],
      );
      if (seen) continue;
      const scoped = { ...q, organizationId: platform.id };
      await notifyPanel(scoped, platformAlertBody(tenant.name, alert), now);
      await recordOrgEvent(scoped, "tenant_critical_alert", { ...alert, tenantId, alertKey: key }, now);
      delivered += 1;
    }
    return delivered;
  });
}
