// spaces.geojson（RQ-004 第二段，v0.7.15）：每个编码一个要素，配上轮廓的是多边形，没配上的（例外）是文字所在的点。
// 坐标是各层的本地坐标（10 毫米一单位，原点在该层图框左上角，y 向下），不是经纬度；楼层看 properties.floor。

import type { Pt } from './model';

export interface GeoRoom {
  floor: string;
  code: string;
  label: string;
  status: string;
  with: string[];
  closeMm: number | null;
  polygon: Pt[] | null;
  labelAt: Pt;
  areaM2: number | null;
}

export function spacesGeoJson(rooms: GeoRoom[], meta: Record<string, unknown>) {
  return {
    type: 'FeatureCollection',
    yuzu: { ...meta, coordinates: '各层本地坐标：10 毫米一单位，原点在该层图框左上角，y 向下' },
    features: rooms.map((r) => ({
      type: 'Feature',
      geometry: r.polygon && r.polygon.length >= 3 ? { type: 'Polygon', coordinates: [[...r.polygon, r.polygon[0]]] } : { type: 'Point', coordinates: r.labelAt },
      properties: { floor: r.floor, code: r.code, label: r.label, status: r.status, mergedWith: r.with, closeMm: r.closeMm, areaM2: r.areaM2, labelAt: r.labelAt },
    })),
  };
}
