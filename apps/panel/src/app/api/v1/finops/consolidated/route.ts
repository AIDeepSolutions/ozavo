import { getConsolidatedFinops } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/**
 * O FinOps de todas as empresas da instalação. Só dono ou administrador da organização que
 * administra a instalação (`platform`); as demais recebem 403 `platform_only`.
 */
export const GET = handle({ platform: true }, ({ deps }) => getConsolidatedFinops(deps.db, deps.clock.now()));
