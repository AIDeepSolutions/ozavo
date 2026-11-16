import { Pool } from "pg";
import type { Db } from "./types";

/**
 * `url` é a conexão do papel de aplicação, sujeita a RLS. `systemUrl` é a do papel de sistema;
 * sem ela o `Db` serve para tudo menos `withSystem` e a fila.
 */
export function createDb(url: string, systemUrl?: string): Db {
  const pool = openPool(url);
  const systemPool = systemUrl === undefined ? undefined : openPool(systemUrl);
  return {
    pool,
    systemPool,
    appUrl: url,
    systemUrl,
    async close() {
      await Promise.all([pool.end(), systemPool?.end()]);
    },
  };
}

/**
 * O papel da conexão de aplicação contorna o RLS (superusuário ou `BYPASSRLS`)? Se sim, `withOrg`
 * não isola nada: toda consulta enxerga todas as organizações. Acontece quando a instalação aponta
 * `DATABASE_URL` para o dono do banco em vez de `ozavo_app`. A saúde do painel trata como falha.
 */
export async function appRoleBypassesRls(db: Db): Promise<boolean> {
  const { rows } = await db.pool.query<{ bypass: boolean }>("select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user");
  // Sem a linha do próprio papel não há como afirmar que o RLS vale: conta como contornado.
  return rows[0]?.bypass ?? true;
}

function openPool(url: string): Pool {
  const pool = new Pool({ connectionString: url });
  // Conexão ociosa que cai (banco reiniciou) emite `error` no pool, e evento `error` sem ouvinte
  // derruba o processo. O pool já descarta essa conexão; a falha real, se houver, aparece na
  // próxima consulta, para quem pode tratá-la.
  pool.on("error", () => undefined);
  return pool;
}

/**
 * Escuta um canal de NOTIFY (`tasks`, `approvals`, `call_events`). Devolve a função que encerra
 * a escuta. Cada escuta segura uma conexão do pool enquanto durar.
 *
 * Se a conexão cair, a escuta acabou: `onError` é chamado para quem quiser reabrir. Sem
 * `onError` o erro derruba o processo de propósito, porque escuta morta em silêncio é fila
 * parada sem ninguém saber.
 */
export async function listen(
  db: Db,
  channel: string,
  onPayload: (payload: string) => void,
  onError?: (error: Error) => void,
): Promise<() => Promise<void>> {
  // O nome do canal entra no texto do comando: LISTEN não aceita parâmetro.
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`Invalid channel name: ${JSON.stringify(channel)}`);

  const client = await db.pool.connect();
  let open = true;
  client.on("notification", (message) => {
    if (message.channel === channel) onPayload(message.payload ?? "");
  });
  client.on("error", (error) => {
    open = false;
    client.release(error);
    if (!onError) throw error;
    onError(error);
  });

  try {
    await client.query(`listen ${channel}`);
  } catch (error) {
    open = false;
    client.release(true);
    throw error;
  }

  return async () => {
    if (!open) return;
    open = false;
    client.removeAllListeners("notification");
    // Destrói a conexão em vez de devolvê-la ao pool: é o que garante que nenhum LISTEN sobra nela.
    client.release(true);
  };
}

/**
 * Quantas conexões escutam `channel` agora, neste banco. Cada escuta de `listen` segura uma
 * conexão cuja última consulta é o próprio `listen <canal>`, e o Postgres mostra esse texto em
 * `pg_stat_activity` para quem conecta com o mesmo papel: por isso a consulta vai pelo pool de
 * aplicação, o mesmo de `listen`. Com outro papel o texto vem oculto e a contagem daria zero.
 */
export async function countListeners(db: Db, channel: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and query = $1",
    [`listen ${channel}`],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Como a conexão de aplicação chega ao banco, lido do endereço:
 *
 * - `local`: o banco está na mesma máquina ou na rede privada (o contêiner `postgres` do Compose,
 *   `localhost`, soquete, faixas privadas). TLS ali é opcional.
 * - `verified`: banco fora da rede com `sslmode=verify-full` ou `verify-ca`: o `pg` só conecta se o
 *   certificado for válido para o nome, então conexão aberta é conexão verificada.
 * - `unverified`: banco fora da rede com TLS que não exige a verificação explícita (`require`,
 *   `prefer`, `no-verify`, `ssl=true`). O `no-verify` aceita qualquer certificado; os outros dependem
 *   de como cada versão do `pg` lê o modo, e a regra da instalação é escrever `verify-full`.
 * - `plaintext`: banco fora da rede sem TLS. Senha e dados de cliente passam em texto puro.
 *
 * Endereço inválido ou ausente conta como `local`: quem não abre conexão não tem o que medir aqui, e
 * a linha do banco já diz se ele respondeu.
 */
export type DatabaseTransport = "local" | "verified" | "unverified" | "plaintext";

export function databaseTransport(url: string | undefined): DatabaseTransport {
  if (!url) return "local";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "local";
  }
  const host = decodeURIComponent(parsed.hostname).replace(/^\[|\]$/g, "").toLowerCase();
  const socketHost = parsed.searchParams.get("host");
  if (isPrivateDatabaseHost(host) || (host === "" && (socketHost === null || socketHost.startsWith("/")))) return "local";
  const mode = parsed.searchParams.get("sslmode")?.toLowerCase();
  if (mode === "verify-full" || mode === "verify-ca") return "verified";
  if (mode === "require" || mode === "prefer" || mode === "no-verify") return "unverified";
  const ssl = parsed.searchParams.get("ssl")?.toLowerCase();
  if (mode === undefined && (ssl === "true" || ssl === "1")) return "unverified";
  return "plaintext";
}

/** Nome sem ponto (serviço do Compose), `localhost`, `.internal`/`.local`, laço e faixas privadas IPv4/IPv6. */
export function isPrivateDatabaseHost(host: string): boolean {
  if (host === "") return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return !host.includes(".") && !host.includes(":");
}

const TRANSPORT_RANK: Record<DatabaseTransport, number> = { local: 0, verified: 0, unverified: 1, plaintext: 2 };

/** O pior transporte entre a conexão de aplicação e a de sistema: as duas levam dado de cliente. */
export function dbTransport(db: Pick<Db, "appUrl" | "systemUrl">): DatabaseTransport {
  const app = databaseTransport(db.appUrl);
  if (db.systemUrl === undefined) return app;
  const system = databaseTransport(db.systemUrl);
  return TRANSPORT_RANK[system] > TRANSPORT_RANK[app] ? system : app;
}
