import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isPlatformOrganization, withOrg } from "@ozavo/core";
import type { ReactNode } from "react";
import { THEME_COOKIE } from "../../i18n/locales";
import { SESSION_COOKIE, findSession, serverDeps } from "../../server/context";
import { LiveProvider } from "../../ui/live";
import { Shell } from "../../ui/shell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const session = await findSession(serverDeps(), jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  // Só decide o que a lateral oferece; cada rota da área de plataforma confere de novo.
  const platform = await withOrg(serverDeps().db, session.organizationId, isPlatformOrganization);
  const theme = jar.get(THEME_COOKIE)?.value;
  return (
    <LiveProvider>
      <Shell me={{ name: session.name, email: session.email, role: session.role, platform }} theme={theme === "light" || theme === "dark" ? theme : undefined}>
        {children}
      </Shell>
    </LiveProvider>
  );
}
