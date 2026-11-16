import { AGENDA_CONNECTOR_KEY, googleConsentUrl, storedAgendaConnector } from "@ozavo/tools/agenda";
import { ApiError, handle } from "../../../../../../server/context";
import { createOAuthState, googleRedirectUri } from "../../../../../../server/oauth-state";

/** O endereço de consentimento do Google para a agenda salva. A tela abre o endereço devolvido. */
export const POST = handle({ configure: true }, async ({ q, session, deps }) => {
  const row = await q.one<{ value: unknown }>("select value from settings where key = $1", [AGENDA_CONNECTOR_KEY]);
  const stored = storedAgendaConnector.safeParse(row?.value);
  if (!stored.success || stored.data.type !== "google_calendar") throw new ApiError(409, "agenda_not_google", "Save the Google Calendar settings before authorizing.");
  const state = createOAuthState({ organizationId: session.organizationId, userId: session.userId }, deps.secretKey, deps.clock.now());
  return { url: googleConsentUrl({ clientId: stored.data.clientId, redirectUri: googleRedirectUri(deps.publicUrl), state }), redirectUri: googleRedirectUri(deps.publicUrl) };
});
