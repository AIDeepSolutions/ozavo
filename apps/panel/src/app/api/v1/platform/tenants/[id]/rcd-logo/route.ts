import { convertRcdLogoSet, getPlatformTenantRcdLogo, setPlatformTenantRcdLogo } from "@ozavo/core";
import { z } from "zod";
import { ApiError, handle, notFound } from "../../../../../../../server/context";

/** Os dois arquivos do logo RCD da empresa, em base64, para baixar. Só a plataforma. */
export const GET = handle({ platform: true }, async ({ deps, session, params }) => {
  const logo = await getPlatformTenantRcdLogo(deps.db, session.organizationId, params.id ?? "");
  if (!logo) throw notFound();
  return { png: logo.png.toString("base64"), bmp: logo.bmp.toString("base64") };
});

/** Converte a imagem enviada para PNG e BMP 256×256 com alfa (até 300 KB cada) e grava na empresa. */
export const PUT = handle({ body: z.object({ image: z.string().min(1).max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }), platform: true }, async ({ body, deps, session, params }) => {
  let logo;
  try {
    logo = await convertRcdLogoSet(Buffer.from(body.image, "base64"));
  } catch {
    throw new ApiError(400, "invalid_rcd_logo", "Invalid RCD image");
  }
  if (!(await setPlatformTenantRcdLogo(deps.db, session.organizationId, session.userId, params.id ?? "", logo, deps.clock.now()))) throw notFound();
  return { png: logo.png.toString("base64"), bmp: logo.bmp.toString("base64"), bytes: { png: logo.png.length, bmp: logo.bmp.length } };
});

/** Remove o logo RCD da empresa. */
export const DELETE = handle({ platform: true }, async ({ deps, session, params }) => {
  if (!(await setPlatformTenantRcdLogo(deps.db, session.organizationId, session.userId, params.id ?? "", null, deps.clock.now()))) throw notFound();
  return { removed: true };
});
