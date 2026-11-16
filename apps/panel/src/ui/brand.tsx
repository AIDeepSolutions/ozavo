"use client";

import Image from "next/image";
import en from "../i18n/en/common";
import es from "../i18n/es/common";
import ptBR from "../i18n/pt-BR/common";
import { useDict } from "../i18n/provider";

// Os arquivos são os oficiais do brand kit (manual da marca v1.0), recortados na borda do desenho:
// positivo para fundo claro, negativo (tipografia em branco, símbolo mantém Cyber Blue e Teal) para
// fundo escuro. Cada tema mostra o seu pelas classes `.oz-on-light` e `.oz-on-dark` de globals.css.
const LOGO_WIDTH = 570;
const LOGO_HEIGHT = 96;

/**
 * O logo horizontal oficial, com a área de proteção do manual em volta (margem livre igual à
 * altura da letra o, em `.oz-logo`). Nunca menor que 96 px de largura: os dois tamanhos passam disso.
 */
export function BrandLogo({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span className="oz-logo" data-size={size}>
      <Image src="/brand/ozavo-logo-positivo.png" alt="Ozavo" width={LOGO_WIDTH} height={LOGO_HEIGHT} unoptimized priority className="oz-on-light" />
      <Image src="/brand/ozavo-logo-negativo.png" alt="Ozavo" width={LOGO_WIDTH} height={LOGO_HEIGHT} unoptimized priority className="oz-on-dark" />
    </span>
  );
}

/** A assinatura obrigatória do manual, no rodapé de toda tela. */
export function BrandSignature({ className = "" }: { className?: string }) {
  const t = useDict(ptBR, en, es).shell;
  return <p className={`text-[0.8rem] text-muted ${className}`}>{t.signature}</p>;
}
