#!/usr/bin/env bash
# 下载概念片用到的字体到 fonts/（不进仓库：鸿蒙字体的许可不允许单独再分发字体文件）。
#   中文   HarmonyOS Sans SC —— 品牌规定的「鸿蒙」；华为官方许可：用它做出的作品可以自由发布、销售。
#   拉丁   TeX Gyre Heros    —— Helvetica 的开源同形字体（GUST Font License）。品牌规定 Helvetica，
#                              Helvetica 本身要另买授权；有授权的话把 fonts/heros-*.otf 换成 Helvetica 即可。
#   宋体   Noto Serif SC     —— 只取「汤 崎 山 水」四个字（SIL OFL），用在「提取偏旁」那一场。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p fonts && cd fonts
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ ! -f HarmonyOS_Sans_SC_Bold.ttf ]; then
  curl -fsSL -o "$TMP/harmony.zip" "https://developer.huawei.com/images/download/general/HarmonyOS-Sans.zip"
  unzip -q -o "$TMP/harmony.zip" 'HarmonyOS Sans/HarmonyOS_Sans_SC/*' -d "$TMP/h"
  for w in Light Regular Medium Bold; do cp "$TMP/h/HarmonyOS Sans/HarmonyOS_Sans_SC/HarmonyOS_Sans_SC_$w.ttf" .; done
  cp "$TMP/h/HarmonyOS Sans/HarmonyOS_Sans_SC/LICENSE.txt" HarmonyOS_Sans_LICENSE.txt
fi

if [ ! -f heros-bold.otf ]; then
  curl -fsSL -o "$TMP/heros.zip" "https://www.gust.org.pl/projects/e-foundry/tex-gyre/heros/qhv2.004otf.zip"
  unzip -q -o "$TMP/heros.zip" -d "$TMP/q"
  cp "$TMP/q/texgyreheros-regular.otf" heros-regular.otf
  cp "$TMP/q/texgyreheros-bold.otf" heros-bold.otf
fi

if [ ! -f notoserifsc-900.woff2 ]; then
  UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  for w in 900 500; do
    css="$(curl -fsSL -A "$UA" --get "https://fonts.googleapis.com/css2" --data-urlencode "family=Noto Serif SC:wght@$w" --data-urlencode "text=汤崎山水")"
    url="$(printf '%s' "$css" | grep -o 'https://[^)]*' | head -1)"
    curl -fsSL -o "notoserifsc-$w.woff2" "$url"
  done
fi
ls -la
