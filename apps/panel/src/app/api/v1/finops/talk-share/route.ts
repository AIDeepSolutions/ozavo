import { getAgentTalkShare } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/** Quanto do tempo das ligações do período foi fala da IA (meta: abaixo de 50%). */
export const GET = handle({}, ({ q, deps }) => getAgentTalkShare(q, deps.clock.now()));
