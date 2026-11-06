// 浴族看板娘「柚子」Q 版设定稿（草稿，docs/MASCOT.md）。
// 一个函数画出整张 SVG：表情 mood 与手里拿的东西 pose 可换；animate 为真时带待机小动作（尊重「减少动态效果」）。
// 只用品牌色：松林绿 #24493A、柚黄 #F2C230、米白纸色、汤崎木色 #937051 一系。
// 同一份代码给设定稿页面用，也用 `node docs/mascot/export.mjs` 导出静态 SVG。

(function (root) {
  const C = {
    ink: '#3B2416',
    skin: '#FFE8D8',
    skinShade: '#F4CBB4',
    skinLine: '#E3AE97',
    hair: '#7A5638',
    hairDeep: '#5A3D27',
    hairLight: '#A9845E',
    robe: '#FBF8F1',
    robeLine: '#D3CBBB',
    pine: '#24493A',
    yuzu: '#F2C230',
    yuzuDeep: '#E0A81A',
    yuzuLight: '#FFE28A',
    wood: '#937051',
    wood2: '#AD8E69',
    wood3: '#C4A67E',
    wood4: '#D2B993',
    water: '#A9D3D0',
    blush: '#FF8E7A',
    mouth: '#A8443A',
    tongue: '#FF9A9A',
    steam: '#DAD3C6',
  };

  const STYLE = `
.yz-all{animation:yz-bob 2.8s ease-in-out infinite}
.yz-pet{animation:yz-wob 2.8s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}
.yz-open{animation:yz-blink 4.6s infinite;transform-box:fill-box;transform-origin:center}
.yz-steam path{animation:yz-steam 2.6s ease-in-out infinite;opacity:0}
.yz-steam path:nth-child(2){animation-delay:.85s}
.yz-steam path:nth-child(3){animation-delay:1.7s}
.yz-spark{animation:yz-twinkle 1.8s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
.yz-spark:nth-of-type(2n){animation-delay:.9s}
.yz-z{animation:yz-float 2.4s ease-in-out infinite}
.yz-drop{animation:yz-drip 1.6s ease-in infinite}
@keyframes yz-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes yz-wob{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}
@keyframes yz-blink{0%,93%,100%{transform:scaleY(1)}95.5%{transform:scaleY(.08)}}
@keyframes yz-steam{0%{opacity:0;transform:translateY(6px)}35%{opacity:.85}100%{opacity:0;transform:translateY(-16px)}}
@keyframes yz-twinkle{0%,100%{transform:scale(.6);opacity:.5}50%{transform:scale(1.1);opacity:1}}
@keyframes yz-float{0%,100%{transform:translate(0,0);opacity:.7}50%{transform:translate(3px,-5px);opacity:1}}
@keyframes yz-drip{0%{transform:translateY(-3px);opacity:0}30%{opacity:1}100%{transform:translateY(5px);opacity:0}}
@media (prefers-reduced-motion:reduce){.yz-all,.yz-pet,.yz-open,.yz-steam path,.yz-spark,.yz-z,.yz-drop{animation:none}.yz-steam path{opacity:.7}}
`;

  function eyeOpen(cx, cy, id, small) {
    if (small) {
      return `<g><circle cx="${cx}" cy="${cy}" r="11" fill="#fff" stroke="${C.ink}" stroke-width="3"/><circle cx="${cx}" cy="${cy + 1}" r="3.8" fill="${C.ink}"/></g>`;
    }
    const out = cx < 120 ? -1 : 1;
    return `<g class="yz-open">
  <ellipse cx="${cx}" cy="${cy}" rx="12.5" ry="15.5" fill="url(#${id}-iris)"/>
  <ellipse cx="${cx}" cy="${cy + 3}" rx="6.2" ry="8" fill="${C.ink}"/>
  <circle cx="${cx - 4}" cy="${cy - 6}" r="4.8" fill="#fff"/>
  <circle cx="${cx + 4.5}" cy="${cy + 6.5}" r="2.1" fill="#fff" opacity=".9"/>
  <path d="M${cx - 14} ${cy - 9}Q${cx} ${cy - 21} ${cx + 14} ${cy - 9}" stroke="${C.ink}" stroke-width="4.2" stroke-linecap="round" fill="none"/>
  <path d="M${cx + out * 12} ${cy - 11}l${out * 6} -4" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>
</g>`;
  }
  const eyeHappy = (cx, cy) =>
    `<path d="M${cx - 11} ${cy + 3}Q${cx} ${cy - 10} ${cx + 11} ${cy + 3}" stroke="${C.ink}" stroke-width="4.2" stroke-linecap="round" fill="none"/>`;
  const eyeSleepy = (cx, cy) =>
    `<g stroke="${C.ink}" stroke-width="4" stroke-linecap="round" fill="none"><path d="M${cx - 11} ${cy}Q${cx} ${cy + 7} ${cx + 11} ${cy}"/><path d="M${cx + (cx < 120 ? -9 : 9)} ${cy + 3}l${cx < 120 ? -4 : 4} 3"/></g>`;

  function face(mood, id) {
    const L = 92, R = 148, Y = 134;
    let eyes, mouth, extra = '';
    switch (mood) {
      case 'yum':
        eyes = eyeHappy(L, Y) + eyeHappy(R, Y);
        mouth = `<path d="M108 160q6 6 12 0q6 6 12 0" stroke="${C.ink}" stroke-width="3" stroke-linecap="round" fill="none"/><path d="M124 162q1 8 6 7q4-1 2-8z" fill="${C.tongue}"/>`;
        extra = `<path class="yz-spark" d="M196 104c-4-6-12-2-9 4l9 9 9-9c3-6-5-10-9-4z" fill="${C.blush}"/>
<path class="yz-spark" d="M42 98l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="${C.yuzu}"/>`;
        break;
      case 'sleepy':
        eyes = eyeSleepy(L, Y) + eyeSleepy(R, Y);
        mouth = `<ellipse cx="120" cy="163" rx="3.6" ry="3" fill="${C.mouth}"/>`;
        extra = `<g class="yz-z" fill="${C.pine}" font-family="system-ui,sans-serif" font-weight="800"><text x="186" y="92" font-size="18">Z</text><text x="204" y="74" font-size="12">z</text></g>`;
        break;
      case 'oops':
        eyes = eyeOpen(L, Y, id, true) + eyeOpen(R, Y, id, true);
        mouth = `<path d="M106 164q3.5-5 7 0t7 0 7 0 7 0" stroke="${C.ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
        extra = `<path class="yz-drop" d="M188 98c5 7 6 11 3 14s-9 1-7-5z" fill="#8CCBE8" stroke="#5EA9CC" stroke-width="1.5"/>
<g fill="${C.ink}" opacity=".55"><path d="M70 110l-8-6M64 120l-10-2" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/></g>`;
        break;
      case 'wink':
        eyes = `<path d="M${L - 11} ${Y - 5}L${L + 9} ${Y + 1}L${L - 11} ${Y + 7}" stroke="${C.ink}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` + eyeOpen(R, Y, id);
        mouth = `<path d="M108 157Q120 170 132 157" stroke="${C.ink}" stroke-width="3" stroke-linecap="round" fill="none"/><path d="M118 163q0 9 6 9t6-9q-6 2-12 0z" fill="${C.tongue}" stroke="${C.mouth}" stroke-width="1.2"/>`;
        extra = `<path class="yz-spark" d="M200 120l3 7.5 7.5 3-7.5 3-3 7.5-3-7.5-7.5-3 7.5-3z" fill="${C.yuzu}"/>
<path class="yz-spark" d="M36 84l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="${C.pine}" opacity=".7"/>`;
        break;
      default: // happy
        eyes = eyeOpen(L, Y, id) + eyeOpen(R, Y, id);
        mouth = `<path d="M107 157Q120 176 133 157Z" fill="${C.mouth}" stroke="${C.ink}" stroke-width="2.4" stroke-linejoin="round"/><path d="M113 165q7 6 14 0q-7-4-14 0z" fill="${C.tongue}"/>`;
        extra = `<path class="yz-spark" d="M200 112l3 7.5 7.5 3-7.5 3-3 7.5-3-7.5-7.5-3 7.5-3z" fill="${C.yuzu}"/>
<path class="yz-spark" d="M38 96l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="${C.yuzu}"/>`;
    }
    const blush = `<g fill="${C.blush}" opacity=".42"><ellipse cx="72" cy="157" rx="11" ry="6"/><ellipse cx="168" cy="157" rx="11" ry="6"/></g>
<g stroke="#F06A5A" stroke-width="1.6" stroke-linecap="round" opacity=".5"><path d="M66 158l3-4M72 158l3-4M78 158l3-4M162 158l3-4M168 158l3-4M174 158l3-4"/></g>`;
    const brows =
      mood === 'oops'
        ? `<g stroke="${C.hairDeep}" stroke-width="3" stroke-linecap="round"><path d="M82 111l14 4"/><path d="M158 111l-14 4"/></g>`
        : `<g stroke="${C.hairDeep}" stroke-width="3" stroke-linecap="round" fill="none"><path d="M83 114q9-5 18-1"/><path d="M139 113q9-4 18 1"/></g>`;
    return { eyes, mouth, blush, brows, extra };
  }

  function held(pose) {
    const steam = `<g class="yz-steam" stroke="${C.steam}" stroke-width="2.4" stroke-linecap="round" fill="none">
  <path d="M110 224c-4-4 4-7 0-12"/><path d="M121 222c-4-4 4-7 0-12"/><path d="M132 224c-4-4 4-7 0-12"/></g>`;
    if (pose === 'bowl') {
      return `${steam}
<path d="M150 214L178 190M156 218L184 196" stroke="${C.wood}" stroke-width="3.4" stroke-linecap="round"/>
<path d="M97 232Q103 212 120 214Q137 212 143 232Z" fill="#FFFDF8" stroke="#E4DED1" stroke-width="2"/>
<g fill="#EFE7D6"><ellipse cx="110" cy="224" rx="2" ry="1.2"/><ellipse cx="121" cy="219" rx="2" ry="1.2"/><ellipse cx="131" cy="225" rx="2" ry="1.2"/><ellipse cx="118" cy="228" rx="2" ry="1.2"/></g>
<g transform="translate(130 218)"><circle r="7" fill="${C.yuzu}" stroke="${C.yuzuDeep}" stroke-width="1.5"/><circle r="4.6" fill="${C.yuzuLight}"/><path d="M0-4.6V4.6M-4 -2.3L4 2.3M-4 2.3L4-2.3" stroke="#fff" stroke-width="1"/></g>
<path d="M92 231Q94 268 120 270Q146 268 148 231Z" fill="#FFFFFF" stroke="${C.robeLine}" stroke-width="2.2" stroke-linejoin="round"/>
<path d="M95 241Q120 250 145 241" stroke="${C.pine}" stroke-width="3" fill="none"/>
<path d="M110 270h20l-2 5h-16z" fill="${C.robeLine}"/>`;
    }
    return `
<path d="M92 236L148 236L143 275L97 275Z" fill="${C.wood3}" stroke="${C.wood}" stroke-width="2.2" stroke-linejoin="round"/>
<g stroke="${C.wood2}" stroke-width="1.6"><path d="M106 237l-1 38M120 237v38M134 237l1 38"/></g>
<path d="M93.5 245h53M96 266h48" stroke="#6E5238" stroke-width="3.2" stroke-linecap="round"/>
<ellipse cx="120" cy="236" rx="28.5" ry="6.5" fill="${C.wood4}" stroke="${C.wood}" stroke-width="2.2"/>
<ellipse cx="120" cy="236.5" rx="24" ry="4.2" fill="${C.water}"/>
${steam}
<g><circle cx="129" cy="232" r="8" fill="${C.yuzu}" stroke="${C.yuzuDeep}" stroke-width="1.6"/><path d="M128 224.5c2-4 6-5 9-4-1 3-5 5-9 4z" fill="#5E9B5E"/><circle cx="126" cy="229.5" r="2" fill="#fff" opacity=".6"/></g>
<circle cx="110" cy="235" r="5" fill="${C.yuzu}" stroke="${C.yuzuDeep}" stroke-width="1.4"/>`;
  }

  function yuzuSVG(opts) {
    const o = opts || {};
    const mood = o.mood || 'happy';
    const pose = o.pose || 'bucket';
    const id = o.id || 'yz';
    const animate = o.animate !== false;
    const f = face(mood, id);
    const title = o.title ? `<title>${o.title}</title>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -16 240 316"${o.className ? ` class="${o.className}"` : ''} role="img" aria-label="${o.title || '柚子'}">${title}
<defs>
  <radialGradient id="${id}-yz" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="${C.yuzuLight}"/><stop offset=".65" stop-color="${C.yuzu}"/><stop offset="1" stop-color="${C.yuzuDeep}"/></radialGradient>
  <linearGradient id="${id}-iris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5A3418"/><stop offset=".55" stop-color="#B07A12"/><stop offset="1" stop-color="${C.yuzu}"/></linearGradient>
  <linearGradient id="${id}-hair" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.hair}"/><stop offset="1" stop-color="${C.hairDeep}"/></linearGradient>
</defs>
${animate ? `<style>${STYLE}</style>` : ''}
<ellipse cx="120" cy="291" rx="58" ry="6.5" fill="${C.ink}" opacity=".1"/>
<g class="yz-all">
<!-- 后发 -->
<path d="M44 124C40 62 80 34 120 34S200 62 196 124C196 168 190 196 178 212C168 206 162 200 158 192H82C78 200 72 206 62 212C50 196 44 168 44 124Z" fill="url(#${id}-hair)"/>
<!-- 木屐 -->
<ellipse cx="103" cy="287" rx="14" ry="5" fill="${C.wood}"/><ellipse cx="137" cy="287" rx="14" ry="5" fill="${C.wood}"/>
<ellipse cx="103" cy="282" rx="9" ry="5" fill="${C.skin}" stroke="${C.skinLine}" stroke-width="1.4"/><ellipse cx="137" cy="282" rx="9" ry="5" fill="${C.skin}" stroke="${C.skinLine}" stroke-width="1.4"/>
<!-- 浴衣：米白麻，松林绿领口 -->
<rect x="112" y="174" width="16" height="20" fill="${C.skinShade}"/>
<path d="M84 190C72 220 66 254 68 282Q120 294 172 282C174 254 168 220 156 190Q120 184 84 190Z" fill="${C.robe}" stroke="${C.robeLine}" stroke-width="2"/>
<g fill="${C.yuzu}" opacity=".55"><circle cx="82" cy="270" r="2.2"/><circle cx="94" cy="262" r="1.6"/><circle cx="156" cy="272" r="2.2"/><circle cx="148" cy="264" r="1.6"/></g>
<path d="M104 190L120 222L136 190Z" fill="${C.skin}"/>
<path d="M140 189L117 225" stroke="${C.pine}" stroke-width="8"/>
<path d="M100 189L124 229" stroke="${C.pine}" stroke-width="8"/>
<!-- 腰带：松林绿，柚黄绳结 -->
<path d="M71 238H169L171 258H69Z" fill="${C.pine}"/>
<path d="M70 248H170" stroke="${C.yuzu}" stroke-width="2.6"/>
<g transform="translate(160 248)"><ellipse cx="-7" cy="-4" rx="8" ry="4.6" transform="rotate(-25)" fill="${C.yuzu}"/><ellipse cx="7" cy="-4" rx="8" ry="4.6" transform="rotate(25)" fill="${C.yuzu}"/><path d="M-2 2l-5 12M2 2l6 11" stroke="${C.yuzu}" stroke-width="2.6" stroke-linecap="round"/><circle r="3.6" fill="${C.yuzuDeep}"/></g>
<!-- 袖子 -->
<path d="M86 194C68 206 60 232 70 250C80 260 96 254 102 244C96 230 94 212 96 198Z" fill="${C.robe}" stroke="${C.robeLine}" stroke-width="2" stroke-linejoin="round"/>
<path d="M154 194C172 206 180 232 170 250C160 260 144 254 138 244C144 230 146 212 144 198Z" fill="${C.robe}" stroke="${C.robeLine}" stroke-width="2" stroke-linejoin="round"/>
<path d="M72 249Q86 259 101 245M168 249Q154 259 139 245" stroke="${C.pine}" stroke-width="3" fill="none" stroke-linecap="round"/>
${held(pose)}
<!-- 手 -->
<circle cx="99" cy="239" r="7.5" fill="${C.skin}" stroke="${C.skinLine}" stroke-width="1.6"/>
<circle cx="141" cy="239" r="7.5" fill="${C.skin}" stroke="${C.skinLine}" stroke-width="1.6"/>
<!-- 脸 -->
<path d="M58 122C58 84 86 62 120 62S182 84 182 122C182 160 156 184 120 184S58 160 58 122Z" fill="${C.skin}"/>
${f.blush}
${f.brows}
${f.eyes}
${f.mouth}
<!-- 刘海与鬓发 -->
<path d="M48 126C42 66 82 38 120 38S198 66 192 126C188 112 182 102 174 96C176 104 176 110 173 117C168 104 160 96 150 92C152 100 150 107 146 113C140 101 132 94 122 92C120 100 116 106 110 111C108 101 100 95 90 94C92 102 90 109 86 115C80 104 73 98 66 96C62 104 60 111 58 119Z" fill="url(#${id}-hair)"/>
<path d="M50 116C46 150 50 178 64 198C66 186 68 172 66 160C70 168 74 172 78 174C70 160 66 140 66 120Z" fill="${C.hair}"/>
<path d="M190 116C194 150 190 178 176 198C174 186 172 172 174 160C170 168 166 172 162 174C170 160 174 140 174 120Z" fill="${C.hair}"/>
<path d="M76 72Q92 57 112 53M130 53Q150 56 164 70" stroke="${C.hairLight}" stroke-width="4.5" stroke-linecap="round" fill="none" opacity=".8"/>
<path d="M98 58l5 1M137 56l5 1.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".5"/>
<path d="M100 42C88 30 92 16 104 12C100 22 104 32 110 38Z" fill="${C.hair}"/>
<!-- 柚子切片发夹 -->
<g transform="translate(173 94)"><circle r="9.5" fill="${C.yuzu}" stroke="${C.yuzuDeep}" stroke-width="1.8"/><circle r="6.6" fill="${C.yuzuLight}"/><path d="M0-6.6V6.6M-5.7-3.3L5.7 3.3M-5.7 3.3L5.7-3.3" stroke="#fff" stroke-width="1.3"/><circle r="1.4" fill="#fff"/></g>
<!-- 头顶：叠好的汤巾 + 柚柚 -->
<g transform="rotate(-8 120 40)"><rect x="84" y="31" width="72" height="18" rx="8" fill="#fff" stroke="#D9D2C3" stroke-width="2"/><path d="M96 33v14M144 33v14" stroke="${C.pine}" stroke-width="3"/></g>
<g class="yz-pet">
  <path d="M129 2c1-5 5-8 10-7" stroke="${C.wood}" stroke-width="2.4" stroke-linecap="round" fill="none"/>
  <circle cx="128" cy="19" r="15" fill="url(#${id}-yz)"/>
  <path d="M130 4c4-8 13-10 20-7-3 7-12 10-20 7z" fill="#5E9B5E"/>
  <circle cx="122.5" cy="18.5" r="1.9" fill="${C.ink}"/><circle cx="133.5" cy="18.5" r="1.9" fill="${C.ink}"/>
  <path d="M125 23q3 3 6 0" stroke="${C.ink}" stroke-width="1.6" stroke-linecap="round" fill="none"/>
  <ellipse cx="119" cy="23" rx="2.6" ry="1.5" fill="${C.blush}" opacity=".5"/><ellipse cx="137" cy="23" rx="2.6" ry="1.5" fill="${C.blush}" opacity=".5"/>
</g>
${f.extra}
</g>
</svg>`;
  }

  root.yuzuSVG = yuzuSVG;
  if (typeof module !== 'undefined') module.exports = { yuzuSVG };
})(typeof window !== 'undefined' ? window : globalThis);
