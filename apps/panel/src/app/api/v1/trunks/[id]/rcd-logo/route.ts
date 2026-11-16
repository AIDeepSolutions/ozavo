import { z } from "zod";
import { convertRcdLogo } from "@ozavo/core";
import { handle, notFound, ApiError } from "../../../../../../server/context";

export const GET = handle({ configure: true }, async ({ q, params }) => {
  const row = await q.one<{ logo: string | null }>("select encode(rcd_logo_png, 'base64') as logo from trunks where id = $1", [params.id]);
  if (!row) throw notFound();
  return row;
});
export const PUT = handle({ configure: true, body: z.object({ image: z.string().min(1).max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }) }, async ({ q, params, body }) => {
  if (!await q.one("select id from trunks where id = $1", [params.id])) throw notFound();
  let logo: Buffer;
  try { logo = await convertRcdLogo(Buffer.from(body.image, "base64")); }
  catch { throw new ApiError(400, "invalid_rcd_logo", "Invalid RCD image"); }
  await q.exec("update trunks set rcd_logo_png = $2 where id = $1", [params.id, logo]);
  return { logo: logo.toString("base64"), bytes: logo.length };
});
