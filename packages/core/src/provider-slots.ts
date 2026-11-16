import type { Db, OrgQuery } from "./types";
import { withSystem } from "./with-org";

/**
 * As vagas da conta do provedor de síntese de voz (Cartesia), que todas as organizações da
 * instalação dividem.
 *
 * - O teto é um número só, da instalação: o "Chamadas simultâneas do provedor de síntese" que a
 *   organização da plataforma (`organizations.platform`) informa em FinOps. Uma organização comum
 *   só pode apertar esse teto para si, nunca afrouxá-lo (quem grava o valor dela também é a plataforma).
 * - A conta é de todas as chamadas vivas da instalação, recebidas e de saída, de qualquer
 *   organização e de qualquer processo de voz. O recado (caixa postal) e a chamada simulada não
 *   usam o provedor e não contam.
 * - Duas ligações que conferem juntas, em organizações diferentes, esperam uma pela outra: a trava
 *   consultiva da transação de quem confere só solta quando a chamada nova foi gravada (ou a
 *   transação desfeita). A vaga é a própria linha em `calls`: quando a chamada termina, ou falha
 *   antes de conectar, ela deixa de contar sozinha. Linha que ficou presa (o processo caiu) também
 *   para de contar depois do maior tempo máximo de chamada dos agentes, mais uma folga.
 */
export interface ProviderSlots {
  /** Chamadas vivas na instalação inteira que usam o provedor. */
  active: number;
  /** O teto que vale para esta organização: o menor entre o da instalação e o dela. Nulo: sem teto. */
  limit: number | null;
  /** O teto da instalação, informado pela plataforma. */
  installationLimit: number | null;
  full: boolean;
}

/** Chave da trava consultiva global das vagas do provedor. Número fixo, escolhido uma vez. */
export const PROVIDER_SLOTS_LOCK = 7_301_202_611;

const STUCK_CALL_SLACK_SECONDS = 120;

/**
 * Tranca as vagas do provedor até o fim da transação de `q` e conta. Chame dentro de `withOrg`, na
 * MESMA transação que vai gravar a chamada nova. `db` precisa do papel de sistema: a contagem
 * atravessa organizações, e só devolve números.
 */
export async function takeProviderSlots(q: OrgQuery, db: Db, now: Date): Promise<ProviderSlots> {
  if (q.organizationId === "") throw new Error("takeProviderSlots runs inside withOrg: the call being placed belongs to one organization");
  await q.one("select pg_advisory_xact_lock($1) is not null as locked", [PROVIDER_SLOTS_LOCK]);
  const own = await q.one<{ limit: number | null }>('select tts_concurrency_limit as "limit" from operation_settings where organization_id = $1', [q.organizationId]);
  const totals = await withSystem(db, (system) =>
    system.one<{ active: number; installation_limit: number | null }>(
      `with longest as (select coalesce(max(max_call_seconds), 600) + $2::int as seconds from agents)
       select
         (select count(*)::int from calls, longest
           where status in ('ringing', 'in_progress') and channel <> 'simulated' and not voicemail
             and started_at > $1::timestamptz - make_interval(secs => longest.seconds)) as active,
         (select min(s.tts_concurrency_limit)::int from operation_settings s join organizations o on o.id = s.organization_id where o.platform) as installation_limit`,
      [now, STUCK_CALL_SLACK_SECONDS],
    ),
  );
  const active = totals?.active ?? 0;
  const installationLimit = totals?.installation_limit ?? null;
  const candidates = [installationLimit, own?.limit ?? null].filter((value): value is number => value !== null);
  const limit = candidates.length === 0 ? null : Math.min(...candidates);
  return { active, limit, installationLimit, full: limit !== null && active >= limit };
}
