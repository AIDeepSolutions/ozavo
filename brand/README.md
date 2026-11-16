# Marca do Ozavo

Esta pasta é a fonte única da marca. O README, o site ([ozavo.com.br](https://ozavo.com.br))
e qualquer material sobre o projeto usam os arquivos daqui. Se você precisa do logo, não peça a
ninguém: baixe desta pasta.

## O nome

Escreve-se **Ozavo**: uma palavra, só o O maiúsculo. Não "OZAVO", não "ozavo" em texto corrido.

## O símbolo

Quatro barras de voz que descem até um ponto. As barras são a conversa.
O ponto de cobre é o desfecho: o que ficou feito quando a ligação acabou. A tese do projeto, em
[`VISION.md`](../VISION.md), é que a ligação é o começo de um trabalho; o símbolo é essa frase
desenhada.

## Os arquivos

| Arquivo | O que é | Onde usar |
|---|---|---|
| `ozavo-logo-light.svg` | Marca completa, horizontal, para fundo claro | Topo do README, cabeçalho do site |
| `ozavo-logo-dark.svg` | Marca completa, horizontal, para fundo escuro | Os mesmos lugares, no tema escuro |
| `ozavo-symbol-light.svg` | Símbolo sozinho, para fundo claro | Onde o nome já aparece ao lado |
| `ozavo-symbol-dark.svg` | Símbolo sozinho, para fundo escuro | Idem, no tema escuro |
| `ozavo-icon.svg` | Símbolo sobre o fundo escuro do produto | Ícone do navegador, ícone de aplicativo |
| `ozavo-avatar.png` | O ícone em 512 px | Avatar da organização e de redes |
| `ozavo-cover.png` | Imagem de capa, 1280 × 640 | Prévia do repositório e do site quando o endereço é compartilhado |

## As cores

A marca não tem cor própria: usa os tokens do painel, em
[`apps/panel/src/design/tokens.css`](../apps/panel/src/design/tokens.css). As barras levam a cor
do texto (`--oz-text`) e o ponto leva o acento (`--oz-accent`), cada um no valor do tema.

O cobre é reservado para o que está vivo e para a ação principal. Se tudo é cobre, nada está vivo.

## A tipografia

O nome é composto em Atkinson Hyperlegible Bold, a mesma fonte do painel, e está convertido em
curvas dentro do SVG: o arquivo não depende de fonte instalada.

## O que não fazer

- Não redesenhe o símbolo nem recomponha o nome em outra fonte. Use o arquivo.
- Não troque as cores, não aplique gradiente, sombra ou contorno.
- Não use a versão clara sobre fundo escuro, nem o contrário.
- Deixe em volta da marca, no mínimo, a largura de duas barras de espaço livre.

## Como os arquivos são gerados

Os SVG saem de um script, `scripts/gerar-marca.mjs`, no
[repositório do site](https://github.com/DeskLabs-OpenSource/ozavo-site). Mudou a marca? Rode o
script, confira o resultado e abra o PR aqui. Os dois PNG são renderizados no Chrome a partir dos SVG e de
`scripts/capa.html`, no mesmo repositório; o comando está no fim do script. O site guarda uma cópia, e um teste no CI dele
reprova se a cópia divergir desta pasta.
