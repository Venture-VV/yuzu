#!/usr/bin/env python3
"""从两份品牌书的 PDF 里取出概念片要用的矢量素材，写成 film/assets/brand.json。

用法：
    pip install pymupdf
    python3 tools/extract_brand_assets.py <汤崎品牌书-rgb.pdf> <TANGQI_Branding&VI Strategy.pdf>

取的都是品牌自己的图形，不取照片、不取第三方作品：
  · 图形标「三横三竖」        —— 品牌书第 20 页
  · 竖排字标（2026 主标志）   —— Strategy 第 59 页（方形比例、调过字距的那一版）
  · 五种景象的笔画与底色      —— 品牌书第 37–41 页（林间竹韵、湖面波光、海中舟迹、风中摇叶、山间石洞）
  · 木 / 麻的六个主色         —— 品牌书第 27 页的色块

标志的路径原样取出，不重画、不改比例。图形标里左、中两竖与上面一横在原稿里是并在一起的一条轮廓，
动画要六笔分开飞，这里按原稿「同一笔竖画平移三次」的关系拆开（平移量由三竖顶端的坐标差算出，
误差小于 0.1 个单位）；落定以后画的是原稿的四条轮廓。
"""
import json
import os
import re
import sys

import pymupdf


def path_d(d, ox=0.0, oy=0.0):
    out, cur = [], None

    def P(p):
        return f"{p.x - ox:.3f} {p.y - oy:.3f}"

    for it in d["items"]:
        k = it[0]
        if k == "l":
            a, b = it[1], it[2]
            if cur is None or abs(a.x - cur.x) > 1e-3 or abs(a.y - cur.y) > 1e-3:
                out.append("M" + P(a))
            out.append("L" + P(b))
            cur = b
        elif k == "c":
            a, b, c, e = it[1], it[2], it[3], it[4]
            if cur is None or abs(a.x - cur.x) > 1e-3 or abs(a.y - cur.y) > 1e-3:
                out.append("M" + P(a))
            out.append("C" + P(b) + " " + P(c) + " " + P(e))
            cur = e
        elif k == "re":
            r = it[1]
            out.append(f"M{r.x0 - ox:.3f} {r.y0 - oy:.3f}H{r.x1 - ox:.3f}V{r.y1 - oy:.3f}H{r.x0 - ox:.3f}Z")
            cur = None
        elif k == "qu":
            q = it[1]
            out.append("M" + P(q.ul) + "L" + P(q.ur) + "L" + P(q.lr) + "L" + P(q.ll) + "Z")
            cur = None
    out.append("Z")
    return "".join(out)


def hexc(f):
    return "#%02X%02X%02X" % tuple(round(c * 255) for c in f)


def filled_in(page, box):
    x0, y0, x1, y1 = box
    sel = []
    for d in page.get_drawings():
        r = d["rect"]
        if d.get("fill") is None:
            continue
        if r.x0 >= x0 and r.y0 >= y0 and r.x1 <= x1 and r.y1 <= y1:
            sel.append(d)
    return sel


def group(page, box):
    """一个框里的全部填充路径，换成以它们自身外接框左上角为原点。"""
    sel = filled_in(page, box)
    bx0 = min(d["rect"].x0 for d in sel)
    by0 = min(d["rect"].y0 for d in sel)
    bx1 = max(d["rect"].x1 for d in sel)
    by1 = max(d["rect"].y1 for d in sel)
    parts = []
    for d in sel:
        r = d["rect"]
        parts.append({
            "d": path_d(d, bx0, by0),
            "b": [round(r.x0 - bx0, 3), round(r.y0 - by0, 3), round(r.x1 - bx0, 3), round(r.y1 - by0, 3)],
        })
    return {"w": round(bx1 - bx0, 3), "h": round(by1 - by0, 3), "parts": parts}


def shift_path(d, dx, dy):
    def rep(m):
        cmd, nums = m.group(1), m.group(2)
        vals = [float(v) for v in nums.split()]
        vals = [v + (dx if i % 2 == 0 else dy) for i, v in enumerate(vals)]
        return cmd + " ".join(f"{v:.3f}" for v in vals)

    return re.sub(r"([MLC])([^MLCZ]*)", rep, d)


def first_points(d, n=3):
    nums = [float(v) for v in re.findall(r"-?\d+\.?\d*", d)]
    return list(zip(nums[0::2], nums[1::2]))[:n]


def build_mark(book):
    g = group(book[19], (20, 190, 830, 500))  # 第 20 页
    parts = sorted(g["parts"], key=lambda p: (p["b"][1], p["b"][0]))
    # 原稿四条轮廓：一条「上横 + 左竖 + 中竖」、一条右竖、两条横
    merged = max(parts, key=lambda p: len(p["d"]))
    vright = min(parts, key=lambda p: p["b"][2] - p["b"][0])
    hs = [p for p in parts if p is not merged and p is not vright]
    hmid, hbot = sorted(hs, key=lambda p: p["b"][1])

    segs = re.findall(r"[MLC][^MLCZ]*", merged["d"])
    # 合并轮廓的走向（第 0 段是起点 M）：右端 → 上沿 → 中竖（上去再下来）→ 上沿 → 左竖 → 上沿 → 左端 → 下沿 → 右端
    # 中竖是第 4–8 段，左竖是第 10–14 段；把这两处换成直线，剩下的就是单独的一横。
    def endpoint(seg):
        nums = [float(v) for v in re.findall(r"-?\d+\.?\d*", seg)]
        return nums[-2], nums[-1]

    assert len(segs) == 21, len(segs)
    bar = "".join(segs[0:4]) + "L%.3f %.3f" % endpoint(segs[8]) + segs[9] + "L%.3f %.3f" % endpoint(segs[14]) + "".join(segs[15:]) + "Z"

    # 三竖是同一笔：用右竖平移出中竖、左竖。平移量取三竖「右上角」那个顶点的坐标差。
    def top_right(seg_d):
        pts = [(float(a), float(b)) for a, b in re.findall(r"(-?\d+\.?\d*) (-?\d+\.?\d*)", seg_d)]
        return max(pts, key=lambda p: p[0] - p[1] * 0.2)

    tr_right = top_right(vright["d"])
    tr_mid = top_right("".join(segs[4:9]))
    tr_left = top_right("".join(segs[10:15]))
    vmid = shift_path(vright["d"], tr_mid[0] - tr_right[0], tr_mid[1] - tr_right[1])
    vleft = shift_path(vright["d"], tr_left[0] - tr_right[0], tr_left[1] - tr_right[1])

    def bbox_of(d):
        pts = [(float(a), float(b)) for a, b in re.findall(r"(-?\d+\.?\d*) (-?\d+\.?\d*)", d)]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]

    pieces = {
        "h1": {"d": bar, "b": bbox_of(bar)},
        "h2": {"d": hmid["d"], "b": hmid["b"]},
        "h3": {"d": hbot["d"], "b": hbot["b"]},
        "v1": {"d": vleft, "b": bbox_of(vleft)},
        "v2": {"d": vmid, "b": bbox_of(vmid)},
        "v3": {"d": vright["d"], "b": vright["b"]},
    }
    return {"w": g["w"], "h": g["h"], "full": [p["d"] for p in g["parts"]], "pieces": pieces}


def build_logotype(deck):
    g = group(deck[58], (1190, 320, 1530, 650))  # 第 59 页右侧：方形比例的竖排字标
    mid = g["h"] / 2
    top = [p for p in g["parts"] if p["b"][3] <= mid + 5]
    bot = [p for p in g["parts"] if p["b"][1] >= mid - 5]
    assert len(top) == 4 and len(bot) == 4, (len(top), len(bot))
    # 上一行「汤」：三条横（水）+ 右边；下一行「崎」：山（两条轮廓）+ 奇（两条轮廓）
    water = sorted([p for p in top if p["b"][3] - p["b"][1] < g["h"] * 0.12], key=lambda p: p["b"][1])
    tang = [p for p in top if p not in water]
    bot = sorted(bot, key=lambda p: p["b"][0])
    shan_x = min(p["b"][0] for p in bot) + (g["w"] * 0.42)
    shan = [p for p in bot if p["b"][2] <= shan_x]
    qi = [p for p in bot if p not in shan]
    assert len(water) == 3 and len(tang) == 1 and len(shan) == 2 and len(qi) == 2, (len(water), len(tang), len(shan), len(qi))
    return {"w": g["w"], "h": g["h"], "water": water, "tang": tang, "shan": shan, "qi": qi}


def build_patterns(book):
    out = {}
    for name, pn in [("ripple", 38), ("cave", 41), ("bamboo", 37), ("leaf", 40), ("boat", 39)]:
        page = book[pn - 1]
        W, H = page.rect.width, page.rect.height
        bg, strokes = None, []
        for d in page.get_drawings():
            f = d.get("fill")
            if f is None:
                continue
            r = d["rect"]
            if r.width > W * 0.9 and r.height > H * 0.9:
                bg = hexc(f)
            elif min(f) > 0.97:
                strokes.append({"d": path_d(d), "b": [round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)]})
        out[name] = {"w": round(W, 2), "h": round(H, 2), "bg": bg, "strokes": strokes}
    return out


def build_palette(book):
    page = book[26]  # 第 27 页：木 / 麻的六个色块
    sw = []
    for d in page.get_drawings():
        f, r = d.get("fill"), d["rect"]
        if f and 100 < r.width < 200 and r.height > 400:
            sw.append((r.x0, hexc(f)))
    return [c for _, c in sorted(set(sw))]


def main():
    book = pymupdf.open(sys.argv[1])
    deck = pymupdf.open(sys.argv[2])
    data = {
        "source": {
            "mark": "汤崎品牌书 p20",
            "logotype": "TANGQI Branding & VI Strategy p59",
            "patterns": "汤崎品牌书 p37–41",
            "wood": "汤崎品牌书 p27",
        },
        "mark": build_mark(book),
        "logotype": build_logotype(deck),
        "patterns": build_patterns(book),
        "wood": build_palette(book),
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "film", "assets", "brand.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote", os.path.normpath(out), os.path.getsize(out), "bytes")
    print("mark", data["mark"]["w"], "x", data["mark"]["h"], "pieces", list(data["mark"]["pieces"]))
    lt = data["logotype"]
    print("logotype", lt["w"], "x", lt["h"])
    for k, v in data["patterns"].items():
        print("pattern", k, v["bg"], len(v["strokes"]), "strokes")
    print("wood", data["wood"])


if __name__ == "__main__":
    main()
