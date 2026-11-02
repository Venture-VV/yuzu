// 空间台账的合成样例（与 docs/data/space-zones-sample.csv、space-ledger-sample.csv 逐字相同，tests/demo-prepare.test.ts 核对）。
// 打包后的命令行只带 dist/，读不到 docs/data，所以演示数据的场景块用这里的副本。不是门店真实台账。

export const SAMPLE_ZONES_CSV = `楼层,区域名(中文),区域名(英文),备注
L3,样例SPA区,Sample SPA,合成样例（不是门店真实台账）
L3,样例客房区,Sample Rooms,合成样例
L2,样例派对区,Sample Party,合成样例
`;

export const SAMPLE_SPACES_CSV = `楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注
L3,T,T301,SPA,1,样例 SPA 1人间,,样例 SPA T301 1人间,
L3,T,T302,SPA,2,样例 SPA 2人间,,样例 SPA T302 2人间,
L3,U,U310,踩背,1,样例踩背 1人间,,样例 U310,近邻标签 踩背1人间
L3,V,V312,足浴,4,样例足浴 4人间,,样例 V312 4人间,按品牌平面图推断
L3,W,W301,客房,2,样例客房,,样例客房 W301,
L3,W,W302,客房,2,样例客房,,样例客房 W302,
L2,X,X201,派对房,,样例派对房,95m²,样例派对房X201,
`;
