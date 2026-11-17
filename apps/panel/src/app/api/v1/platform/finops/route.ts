import { getPlatformFinops } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/**
 * O FinOps de todas as empresas clientes no ciclo de cada uma: minutos, franquia, custo estimado,
 * receita, margem e alertas críticos. Só dono ou administrador da plataforma.
 */
export const GET = handle({ platform: true }, ({ deps, session }) => getPlatformFinops(deps.db, session.organizationId, deps.clock.now()));
