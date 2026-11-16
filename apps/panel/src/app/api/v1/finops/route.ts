import { getFinopsSummary } from "@ozavo/core";
import { handle } from "../../../../server/context";

/** O resumo de FinOps do ciclo em curso: consumo da franquia, custo, receita e margem. */
export const GET = handle({}, ({ q, deps }) => getFinopsSummary(q, deps.clock.now()));
