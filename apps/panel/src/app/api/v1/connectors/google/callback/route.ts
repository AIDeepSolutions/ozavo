import { decryptSecret, encryptSecret, withOrg } from "@ozavo/core";
import { AGENDA_CONNECTOR_KEY, exchangeGoogleCode, storedAgendaConnector } from "@ozavo/tools/agenda";
import { findSession, readCookie, serverDeps, SESSION_COOKIE } from "../../../../../../server/context";
import { googleRedirectUri, readOAuthState } from "../../../../../../server/oauth-state";

/**
 * A volta do Google depois do consentimento. Não é chamada pela tela, e sim pelo navegador
 * redirecionado: a resposta é sempre um redirecionamento de volta para Integrações, com o
 * resultado no endereço (`agenda=authorized` ou `agenda=failed&reason=`). Vale só com a sessão da
 * mesma pessoa e empresa que pediu (o `state` assinado diz quem foi).
 */
export async function GET(request: Request): Promise<Response> {
  const deps = serverDeps();
  const back = (result: string): Response => Response.redirect(`${deps.publicUrl.replace(/\/+$/, "")}/settings/integrations?agenda=${result}`, 303);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = readOAuthState(url.searchParams.get("state") ?? "", deps.secretKey, deps.clock.now());
  if (url.searchParams.get("error")) return back("failed&reason=denied");
  if (!code || !state) return back("failed&reason=invalid_state");
  const session = await findSession(deps, readCookie(request, SESSION_COOKIE));
  if (!session || session.organizationId !== state.organizationId || session.userId !== state.userId) return back("failed&reason=session");

  const stored = await withOrg(deps.db, state.organizationId, async (q) => storedAgendaConnector.safeParse((await q.one<{ value: unknown }>("select value from settings where key = $1", [AGENDA_CONNECTOR_KEY]))?.value));
  if (!stored.success || stored.data.type !== "google_calendar") return back("failed&reason=not_google");
  const google = stored.data;
  let refreshToken: string;
  try {
    refreshToken = await exchangeGoogleCode(
      { clientId: google.clientId, clientSecret: decryptSecret(google.clientSecretEnc, deps.secretKey), code, redirectUri: googleRedirectUri(deps.publicUrl) },
      { fetch: deps.fetch, lookup: deps.lookup },
    );
  } catch (error) {
    process.stderr.write(`[panel] google authorization failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return back("failed&reason=exchange");
  }
  // Só grava se a configuração ainda é a do mesmo cliente OAuth que pediu a autorização.
  const saved = await withOrg(deps.db, state.organizationId, (q) =>
    q.exec("update settings set value = value || jsonb_build_object('refreshTokenEnc', $2::text), updated_at = $3 where key = $1 and value->>'type' = 'google_calendar' and value->>'clientId' = $4", [
      AGENDA_CONNECTOR_KEY,
      encryptSecret(refreshToken, deps.secretKey),
      deps.clock.now(),
      google.clientId,
    ]),
  );
  return back(saved === 1 ? "authorized" : "failed&reason=changed");
}
