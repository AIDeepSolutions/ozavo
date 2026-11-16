import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { LOCALE_COOKIE, THEME_COOKIE, pickLocale } from "../i18n/locales";
import { LocaleProvider } from "../i18n/provider";
import loginEn from "../i18n/en/login";
import loginEs from "../i18n/es/login";
import loginPtBR from "../i18n/pt-BR/login";
import manifest from "../../public/manifest.json";
import "./globals.css";

// As fontes moram no repositório (./fonts, subconjunto latino, do Fontsource 5.3.0, licença OFL ao
// lado): a construção não baixa nada de fora, e sem acesso ao serviço de fontes a imagem ainda sai.
// Inter é a tipografia do manual da marca: 800 em títulos e números de destaque, 700 em subtítulos
// e cabeçalhos de tabela, 400 no corpo. A reserva (Segoe UI, Helvetica Neue, Arial) está em globals.css.
const inter = localFont({
  src: [
    { path: "./fonts/inter-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/inter-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/inter-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/inter-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/inter-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/inter-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-inter",
});
const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex-mono",
});

// Ícones oficiais do brand kit (manual v1.0): o favicon usa só o símbolo. `favicon.ico` (16 e 32 px)
// mora em ./favicon.ico e o Next o serve sozinho; os PNG estão em public/brand.
const SYMBOL_SIZES = [16, 32, 64, 192, 512, 1024] as const;
const ICONS: Metadata["icons"] = {
  icon: [{ url: "/brand/ozavo-symbol.svg", type: "image/svg+xml" }, ...SYMBOL_SIZES.map((size) => ({ url: `/brand/ozavo-symbol-${size}.png`, sizes: `${size}x${size}`, type: "image/png" }))],
  apple: [{ url: "/brand/ozavo-apple-touch-180.png", sizes: "180x180", type: "image/png" }],
};
const LEADS = { "pt-BR": loginPtBR.lead, en: loginEn.lead, es: loginEs.lead } as const;

// A descrição segue o idioma de quem abre; o manifesto (public/manifest.json) guarda nome, ícones e
// a cor da barra do navegador, Deep Navy, a mesma do token `--oz-text`.
export async function generateMetadata(): Promise<Metadata> {
  const jar = await cookies();
  const locale = pickLocale(jar.get(LOCALE_COOKIE)?.value, (await headers()).get("accept-language"));
  return { title: "Ozavo", description: LEADS[locale], manifest: "/manifest.json", icons: ICONS };
}

export const viewport: Viewport = { themeColor: manifest.theme_color };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const locale = pickLocale(jar.get(LOCALE_COOKIE)?.value, (await headers()).get("accept-language"));
  const theme = jar.get(THEME_COOKIE)?.value;
  return (
    <html lang={locale} data-theme={theme === "light" || theme === "dark" ? theme : undefined} className={`${inter.variable} ${plexMono.variable}`}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
