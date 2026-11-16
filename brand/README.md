# Marca do Ozavo

Esta pasta é a fonte única da marca no repositório. O README e qualquer material sobre o projeto
usam os arquivos daqui. Se você precisa do logo, não peça a ninguém: baixe desta pasta.

A marca é a identidade visual oficial v1.0 da AI Deep Solutions (brand kit e manual da marca,
recebidos em 16/11/2026). O painel usa a mesma identidade: os arquivos dele ficam em
[`apps/panel/public/brand/`](../apps/panel/public/brand/), e as cores, em
[`apps/panel/src/design/tokens.css`](../apps/panel/src/design/tokens.css).

## O nome

No logo, **ozavo**, em caixa baixa. Em texto corrido, **Ozavo**: uma palavra, só o O maiúsculo.
Nunca "OZAVO".

## O símbolo

Um infinito acústico: dois anéis entrelaçados, em Cyber Blue e Digital Teal, atravessados por
barras de voz. O nome vem ao lado, em Deep Navy no fundo claro e em branco no fundo escuro.

## As cores

Cores sólidas, sem degradê e sem roxo, violeta ou magenta.

| Nome | Valor | Uso |
|---|---|---|
| Deep Navy | `#071D3A` | Nome no fundo claro, fundos escuros, texto |
| Cyber Blue | `#0052CC` | Anel e barras da esquerda, ação principal |
| Digital Teal | `#00B4D8` | Anel e barras da direita, destaque |
| Branco | `#FFFFFF` | Fundo claro, nome no fundo escuro |

## A tipografia

Inter. No painel, a fonte está versionada no repositório (`apps/panel/src/app/fonts/`, licença
OFL), sem baixar de serviço externo. Os SVG desta pasta escrevem o nome como texto, com Inter
primeiro na lista de fontes: onde Inter não está instalada, o navegador usa a próxima da lista.
Para um uso em que a fonte precisa ser exata, use os PNG do kit.

## A assinatura

Em rodapé, proposta e contrato: **"Ozavo — Uma solução AI Deep Solutions"**. A frase é fixa, em
português, em qualquer idioma da tela: o painel em inglês e em espanhol mostra a mesma assinatura,
sem tradução.

## Os arquivos

| Arquivo | O que é | Onde usar |
|---|---|---|
| `ozavo-logo-light.svg` | Marca completa, horizontal, para fundo claro (o "positivo" do kit) | Topo do README |
| `ozavo-logo-dark.svg` | Marca completa, horizontal, para fundo escuro (o "negativo" do kit) | O mesmo lugar, no tema escuro |
| `ozavo-symbol-light.svg` | Símbolo sozinho, para fundo claro | Onde o nome já aparece ao lado |
| `ozavo-symbol-dark.svg` | Símbolo sozinho, para fundo escuro | Idem, no tema escuro |
| `ozavo-icon.svg` | O símbolo do kit | Ícone |
| `ozavo-avatar.png` | Avatar com fundo Deep Navy, 512 px | Avatar da organização e de redes |
| `ozavo-cover.png` | Capa 1280 × 640: faixas Cyber Blue e Digital Teal, o logo positivo e o rodapé Deep Navy | Prévia do repositório quando o endereço é compartilhado |

De onde cada um veio, no kit (`brand/_brandkit`, fora do repositório):

- `ozavo-logo-light.svg`, `ozavo-logo-dark.svg`, `ozavo-symbol-light.svg` e `ozavo-icon.svg`: cópias de
  `01_Logos_Vetoriais_SVG/` (`ozavo_horizontal_positivo.svg`, `ozavo_horizontal_negativo.svg`,
  `ozavo_simbolo_icone.svg`).
- `ozavo-symbol-dark.svg`: o símbolo do kit com a mesma troca que o kit faz entre o logo positivo e
  o negativo, Deep Navy por branco nas barras das pontas. O kit não traz o símbolo negativo isolado.
- `ozavo-avatar.png`: `03_Icones_Favicons_App/ozavo_app_avatar_navy_512x512.png`.
- `ozavo-cover.png`: composta com o `sharp` (dependência do projeto) a partir de
  `02_Logos_Alta_Resolucao_PNG/ozavo_horizontal_positivo_transparente.png`, sem texto novo. A peça
  `KV_04_LinkedIn_Enterprise_OG_Banner_1200x628.png` do kit não foi usada como capa: ela traz uma
  promessa comercial que não cabe na prévia do repositório aberto.

## O que não fazer

- Não redesenhe o símbolo nem recomponha o nome em outra fonte. Use o arquivo.
- Não troque as cores, não aplique degradê, sombra ou contorno, e não use roxo.
- Não use a versão para fundo claro sobre fundo escuro, nem o contrário.
- Não traduza a assinatura.
- Deixe espaço livre em volta da marca.

## O site

O site ([ozavo.com.br](https://ozavo.com.br)) mora em outro repositório e guardava uma cópia da
marca anterior, com um teste de paridade contra esta pasta. Trocar a cópia do site faz parte do
trabalho do site, não deste repositório.
