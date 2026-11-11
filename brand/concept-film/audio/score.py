#!/usr/bin/env python3
"""汤崎品牌概念片《动静之间》的配乐与声音 —— 全部用程序合成，没有用任何现成的音乐、采样或音效。

    pip install numpy scipy
    python3 audio/score.py [输出.wav]        # 默认写到 audio/score.wav（48 kHz、立体声、72 秒）

60 拍 / 分钟，一小节 4 秒，和画面的场次一一对齐（时间点与 film/scenes/*.js 里的相同）。
D 调五声（D E F# A B），音色只有几样：垫底的长音、拨片（像拇指琴）、木头的「笃」、水滴、
颂钵、很轻的鼓与沙锤。开头的「城市」是密集的滴答声，随着那句话慢下来、停住。
"""
import sys
import os
import numpy as np
from scipy import signal

SR = 48000
DUR = 72.0
N = int(SR * DUR)
rng = np.random.default_rng(20261111)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


D2, A2, B1, B2, G2, A1, E2 = 38, 45, 35, 47, 43, 33, 40
D3, E3, Fs3, G3, A3, B3 = 50, 52, 54, 55, 57, 59
Cs4, D4, E4, Fs4, G4, A4, B4 = 61, 62, 64, 66, 67, 69, 71
Cs5, D5, E5, Fs5, A5, B5, D6 = 73, 74, 76, 78, 81, 83, 86

dry = np.zeros((N, 2))
wet = np.zeros((N, 2))  # 送进混响的那一路


def place(sig, t0, gain=1.0, pan=0.0, send=0.25):
    """把一段单声道声音放到 t0 秒。pan: -1 左 … 1 右；send: 送混响的比例。"""
    i0 = int(round(t0 * SR))
    if i0 >= N:
        return
    if i0 < 0:
        sig, i0 = sig[-i0:], 0
    sig = sig[: N - i0]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    st = np.stack([sig * l, sig * r], axis=1) * gain
    dry[i0:i0 + len(sig)] += st
    wet[i0:i0 + len(sig)] += st * send


def tt(d):
    return np.arange(int(d * SR)) / SR


def env_exp(d, tau, attack=0.004):
    t = tt(d)
    e = np.exp(-t / tau)
    a = np.clip(t / attack, 0, 1)
    return e * a * a * (3 - 2 * a)


def fade(sig, fin=0.01, fout=0.05):
    n_in, n_out = int(fin * SR), int(fout * SR)
    sig = sig.copy()
    if n_in:
        sig[:n_in] *= np.linspace(0, 1, n_in) ** 2
    if n_out:
        sig[-n_out:] *= np.linspace(1, 0, n_out) ** 2
    return sig


def lp(x, fc, order=2):
    b, a = signal.butter(order, fc / (SR / 2), 'low')
    return signal.lfilter(b, a, x)


def hp(x, fc, order=2):
    b, a = signal.butter(order, fc / (SR / 2), 'high')
    return signal.lfilter(b, a, x)


def bp(x, f1, f2, order=2):
    b, a = signal.butter(order, [f1 / (SR / 2), f2 / (SR / 2)], 'band')
    return signal.lfilter(b, a, x)


# ---------- 音色 ----------
def pluck(note, d=2.2, bright=1.0):
    """拨片 / 拇指琴：基音 + 两个不谐和的泛音，起音有一点点「嗒」。"""
    f = midi(note)
    t = tt(d)
    s = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.55)
    s += 0.40 * bright * np.sin(2 * np.pi * f * 3.01 * t + 0.4) * np.exp(-t / 0.18)
    s += 0.20 * bright * np.sin(2 * np.pi * f * 5.43 * t + 1.1) * np.exp(-t / 0.08)
    s += 0.25 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / 0.30)
    click = bp(rng.standard_normal(len(t)), 1800, 6500) * np.exp(-t / 0.005) * 0.34 * bright
    a = np.clip(t / 0.003, 0, 1)
    return fade((s + click) * a, 0, 0.1)


def wood(note, d=0.5):
    """木头的「笃」：很短的正弦 + 一点木腔的共鸣。"""
    f = midi(note)
    t = tt(d)
    s = np.sin(2 * np.pi * f * t + 0.3) * np.exp(-t / 0.055)
    s += 0.5 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / 0.022)
    s += bp(rng.standard_normal(len(t)), 500, 2600) * np.exp(-t / 0.006) * 0.5
    return fade(s, 0.001, 0.05)


def drop(f0=950.0, d=0.5):
    """水滴：音高很快往上滑的一小声「咚」。"""
    t = tt(d)
    f = f0 * (1 + 0.9 * (1 - np.exp(-t / 0.018)))
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t / 0.07)
    return fade(s * np.clip(t / 0.002, 0, 1), 0, 0.05)


def bowl(note, d=9.0, tau=3.2):
    """颂钵：几个不成倍数的泛音，各自带一点拍频，余音很长。"""
    f = midi(note)
    t = tt(d)
    s = np.zeros(len(t))
    for ratio, amp, tk, beat in [(1.0, 1.0, 1.0, 0.7), (2.71, 0.42, 0.55, 1.3), (5.15, 0.16, 0.3, 2.1), (8.3, 0.06, 0.16, 3.0)]:
        s += amp * (np.sin(2 * np.pi * f * ratio * t) + np.sin(2 * np.pi * (f * ratio + beat) * t + 1.0)) * 0.5 * np.exp(-t / (tau * tk))
    return fade(s * np.clip(t / 0.02, 0, 1), 0, 0.5)


def pad(notes, d, attack=1.6, release=2.4, cutoff=1900.0):
    """垫底的长音：每个音叠几层略微失谐的泛音，慢起慢收。返回立体声 (n, 2)。"""
    t = tt(d)
    out = np.zeros((len(t), 2))
    for n in notes:
        f = midi(n)
        for ch in (0, 1):
            s = np.zeros(len(t))
            for det in (-0.0035, 0.0, 0.0041):
                ff = f * (1 + det + (0.0012 if ch else -0.0012))
                ph0 = rng.uniform(0, 2 * np.pi)
                for h in range(1, 7):
                    if ff * h > cutoff * 2.2:
                        break
                    s += np.sin(2 * np.pi * ff * h * t + ph0 * h) / (h ** 1.7)
            out[:, ch] += s
    out /= max(1, len(notes)) * 2.2
    out[:, 0] = lp(out[:, 0], cutoff)
    out[:, 1] = lp(out[:, 1], cutoff)
    out[:, 0] = hp(out[:, 0], 110)
    out[:, 1] = hp(out[:, 1], 110)
    e = np.clip(t / attack, 0, 1) ** 1.5 * np.clip((d - t) / release, 0, 1) ** 1.5
    trem = 1 + 0.06 * np.sin(2 * np.pi * 0.17 * t + 0.8)
    return out * (e * trem)[:, None]


def place_st(sig, t0, gain=1.0, send=0.4):
    i0 = int(round(t0 * SR))
    sig = sig[: max(0, N - i0)]
    dry[i0:i0 + len(sig)] += sig * gain
    wet[i0:i0 + len(sig)] += sig * gain * send


def bass(note, d=3.6):
    f = midi(note)
    t = tt(d)
    s = np.sin(2 * np.pi * f * t) + 0.28 * np.sin(2 * np.pi * 2 * f * t + 0.5) + 0.08 * np.sin(2 * np.pi * 3 * f * t)
    e = np.clip(t / 0.03, 0, 1) * np.exp(-t / 1.9) * np.clip((d - t) / 0.3, 0, 1)
    return lp(s * e, 420) * 0.78


def kick(d=0.5, f1=95.0, f2=44.0):
    """很软的底鼓，像隔着毛毡敲。"""
    t = tt(d)
    f = f2 + (f1 - f2) * np.exp(-t / 0.035)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
    return lp(s * np.clip(t / 0.003, 0, 1), 260)


def shaker(d=0.09):
    t = tt(d)
    s = bp(rng.standard_normal(len(t)), 5200, 11000) * np.clip(t / 0.012, 0, 1) * np.exp(-t / 0.028)
    return s


def clap(d=0.22):
    t = tt(d)
    e = sum(np.exp(-np.clip(t - dt, 0, None) / 0.012) * (t >= dt) for dt in (0.0, 0.011, 0.023)) / 3
    e += 0.35 * np.exp(-t / 0.06)
    return bp(rng.standard_normal(len(t)), 1100, 3600) * e


def tom(note, d=0.9):
    f = midi(note)
    t = tt(d)
    ff = f * (1 + 0.5 * np.exp(-t / 0.03))
    s = np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.exp(-t / 0.22)
    return lp(s * np.clip(t / 0.004, 0, 1), 700)


def tick(d=0.06, f=2600.0):
    t = tt(d)
    s = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.006) + hp(rng.standard_normal(len(t)), 4000) * np.exp(-t / 0.0015) * 0.6
    return s


def swell(d, f_lo=300.0, f_hi=5000.0, shape=2.2):
    """一口气：滤过的噪声慢慢涨起来，越来越亮（几条频带依次推上去）。"""
    t = tt(d)
    x = rng.standard_normal(len(t))
    k = t / d
    out = np.zeros(len(t))
    bands = np.geomspace(f_lo, f_hi, 6)
    for i in range(5):
        c = (i + 0.5) / 5
        w = np.exp(-((k - c) / 0.28) ** 2)
        out += bp(x, bands[i], bands[i + 1]) * w
    return fade(out * k ** shape, 0.05, min(0.25, d * 0.2))


# ---------- 画面的「城市节拍」：与 film/scenes/opening.js 的 beatClock 相同 ----------
def beat_times():
    dt = 1 / 2000
    tau, out, last = 0.0, [], 0
    for i in range(int(5.2 / dt)):
        s = i * dt
        k = 1 - min(1, max(0, (s - 1.4) / (5.0 - 1.4)))
        tau += 11 * k * k * dt
        if int(tau) > last:
            last = int(tau)
            out.append(s)
    return out


# =====================================================================================
# 一、城市节奏 → 山是层次，水为间奏（0–8）
# =====================================================================================
bt = beat_times()
for i, s in enumerate(bt):
    late = min(1.0, s / 5.0)
    f = 2600 if i % 4 else 3300
    place(tick(f=f), s, gain=0.34 * (1 - 0.4 * late) * (1.25 if i % 4 == 0 else 1.0), pan=rng.uniform(-0.75, 0.75), send=0.10 + 0.9 * late ** 2)
# 城市的底噪：低低的嗡声，随着平静下来退掉
t = tt(6.5)
hum = lp(np.cumsum(rng.standard_normal(len(t))) * 0.01, 160)
hum = hp(hum, 35) + 0.25 * np.sin(2 * np.pi * 49 * t) + 0.12 * np.sin(2 * np.pi * 98.5 * t + 1)
hum *= np.clip(t / 0.8, 0, 1) * np.clip((6.2 - t) / 3.6, 0, 1) ** 1.5
place(hum, 0.0, gain=0.20, send=0.1)
place_st(pad([D3, A3], 7.2, attack=1.2, release=2.5, cutoff=900), 0.0, gain=0.16)
place(bass(D2, 5.5), 0.05, 0.22, 0, 0.1)
# 那句话响起：两个很轻的拨片
place(pluck(A4), 0.8, 0.22, -0.2, 0.7); place(pluck(E5, bright=0.7), 1.3, 0.12, 0.1, 0.7)
place(pluck(D5), 2.7, 0.22, 0.2, 0.7); place(pluck(A4, bright=0.7), 3.2, 0.12, -0.1, 0.7)
# 落定：颂钵
place(bowl(D4, 10.0, 3.6), 5.2, 0.34, 0.0, 0.6)
# 水的横线一条条浮出来
for i, (s, n) in enumerate([(5.25, Fs4), (5.55, A4), (5.85, B4), (6.2, D5), (6.6, E5), (7.05, Fs5)]):
    place(drop(700 + i * 110), s, 0.10, (-1) ** i * 0.45, 0.7)
    place(pluck(n, bright=0.7), s + 0.02, 0.10, (-1) ** i * 0.35, 0.6)

# =====================================================================================
# 二、提取山水（8–16）与 三、标志成形（16–24）
# =====================================================================================
place_st(pad([D3, A3, E4, Fs4], 17.5, attack=3.0, release=3.5), 6.6, gain=0.20)
place(bass(D2, 5.0), 8.0, 0.30, 0, 0.1)
# 「汤」的水亮起来：水滴
place(drop(880), 8.9, 0.22, -0.35, 0.8); place(drop(1180, 0.4), 9.13, 0.12, -0.15, 0.8); place(pluck(A5, bright=0.8), 8.92, 0.16, -0.3, 0.7)
# 「崎」的山亮起来：木头与低音
place(wood(D3), 10.7, 0.36, 0.35, 0.5); place(tom(D2), 10.7, 0.34, 0.3, 0.3); place(pluck(D4, bright=0.6), 10.72, 0.14, 0.3, 0.6)
place(bass(D2, 4.0), 12.0, 0.26, 0, 0.1)
# 三横流出来（往下走的三个音），三竖立起来（往上走的三个音）
for s, n, p in [(13.1, B4, -0.5), (13.3, A4, -0.4), (13.5, Fs4, -0.3)]:
    place(pluck(n), s, 0.22, p, 0.6); place(drop(midi(n) * 1.5, 0.3), s, 0.07, p, 0.7)
for s, n, p in [(13.5, D3, 0.3), (13.7, Fs3, 0.4), (13.9, A3, 0.5)]:
    place(wood(n + 12), s, 0.26, p, 0.5); place(pluck(n, bright=0.5), s, 0.16, p, 0.5)
# 两组笔画合到一起：一口气涨上去，落定时一个和弦
place(swell(2.0, 250, 3200), 16.0, 0.10, 0.0, 0.6)
place(bass(D2, 6.0), 18.0, 0.42, 0, 0.1)
place(kick(), 18.0, 0.40, 0, 0.05)
place(bowl(D4, 9.0, 3.0), 18.0, 0.30, 0, 0.6)
for n, p in [(D5, -0.3), (A5, 0.3), (Fs5, 0.0)]:
    place(pluck(n), 18.0, 0.16, p, 0.7)
place_st(pad([D3, A3, D4, Fs4, A4], 7.5, attack=0.6, release=3.0, cutoff=2200), 18.0, gain=0.20)
# 一小段旋律
for s, n in [(19.5, Fs5), (20.0, E5), (20.5, D5), (21.5, A4), (22.0, B4), (22.5, D5)]:
    place(pluck(n, bright=0.7), s, 0.15, rng.uniform(-0.4, 0.4), 0.7)
# 水漫上来
place(swell(1.0, 200, 2600, 1.6), 23.2, 0.13, 0.0, 0.5)

# =====================================================================================
# 四、五种景象（24–44）
# =====================================================================================
def groove(t0, kicks=(0, 2), shakes=8, claps=(), level=1.0):
    for b in kicks:
        place(kick(), t0 + b, 0.36 * level, 0, 0.04)
    for i in range(shakes):
        s = t0 + i * 4 / shakes
        place(shaker(), s + rng.uniform(-0.006, 0.006), (0.064 if i % 2 == 0 else 0.040) * level, 0.5 if i % 2 else -0.5, 0.2)
    for b in claps:
        place(clap(), t0 + b, 0.07 * level, 0.15, 0.5)


def mel(t0, seq, gain=0.17, bright=0.9, send=0.6):
    for off, n in seq:
        place(pluck(n, bright=bright), t0 + off + rng.uniform(-0.008, 0.008), gain * rng.uniform(0.85, 1.05), rng.uniform(-0.45, 0.45), send)


# 01 湖面波光 · 入汤 —— D
place_st(pad([D3, A3, E4, Fs4], 5.2, attack=0.5, release=1.6, cutoff=2000), 23.9, gain=0.18)
place(bass(D2), 24.0, 0.40, 0, 0.08)
groove(24.0, kicks=(0, 2), shakes=8)
mel(24.0, [(0.5, A4), (1.0, D5), (1.5, E5), (2.0, Fs5), (2.5, E5), (3.0, A5), (3.5, Fs5)])
for s in (0.45, 1.3, 2.6):
    place(drop(rng.uniform(800, 1300)), 24.0 + s, 0.11, rng.uniform(-0.6, 0.6), 0.8)
# 02 山间石洞 · 疗愈 —— Bm7
place_st(pad([B2, Fs3, A3, D4], 5.2, attack=0.5, release=1.6, cutoff=1500), 27.9, gain=0.19)
place(bass(B1), 28.0, 0.42, 0, 0.08)
place(bowl(B3, 6.0, 2.2), 28.0, 0.22, -0.2, 0.7)
groove(28.0, kicks=(0,), shakes=4, level=0.8)
place(tom(B1 + 12), 30.0, 0.22, 0.2, 0.4)
mel(28.0, [(1.0, Fs4), (2.0, D5), (3.0, B4), (3.5, A4)], gain=0.15, bright=0.6, send=0.8)
# 03 林间竹韵 · 烟火 —— G
place_st(pad([G3, B3, D4, A4], 5.2, attack=0.5, release=1.6, cutoff=2000), 31.9, gain=0.17)
place(bass(G2), 32.0, 0.38, 0, 0.08)
groove(32.0, kicks=(0, 2), shakes=8)
for i, on in enumerate([1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0]):  # 竹子的「笃笃」
    if on:
        place(wood([G4, B4, D5, B4][i % 4]), 32.0 + i * 0.25, 0.13 if i % 4 else 0.19, 0.55 if i % 2 else -0.55, 0.35)
mel(32.0, [(0.5, B4), (1.5, D5), (2.5, A4), (3.0, G4), (3.5, B4)])
# 04 风中摇叶 · 欢聚 —— A
place_st(pad([A2, E3, B3, Cs4, Fs4], 5.2, attack=0.4, release=1.6, cutoff=2400), 35.9, gain=0.17)
place(bass(A1), 36.0, 0.34, 0, 0.08); place(bass(A2), 36.0, 0.22, 0, 0.08)
groove(36.0, kicks=(0, 1, 2, 3), shakes=16, claps=(1, 3), level=1.05)
mel(36.0, [(0.0, E5), (0.5, Fs5), (1.0, A5), (1.5, Fs5), (2.0, E5), (2.5, Cs5), (3.0, E5), (3.5, A4)], gain=0.19, bright=1.1)
mel(36.0, [(0.25, A4), (1.25, Cs5), (2.25, A4), (3.25, E5)], gain=0.09, bright=0.8)
# 05 海中舟迹 · 停泊 —— D（静下来）
place_st(pad([D3, A3, E4, A4], 6.5, attack=0.8, release=3.0, cutoff=1700), 39.9, gain=0.20)
place(bass(D2, 4.5), 40.0, 0.40, 0, 0.1)
place(kick(), 40.0, 0.30, 0, 0.05)
mel(40.0, [(0.0, D5), (1.5, A4), (3.0, Fs4)], gain=0.17, bright=0.6, send=0.9)
place(bowl(A3, 7.0, 2.6), 42.0, 0.16, 0.25, 0.8)
for s in (0.9, 2.3):
    place(drop(rng.uniform(700, 1000)), 40.0 + s, 0.08, rng.uniform(-0.6, 0.6), 0.9)

# =====================================================================================
# 五、品牌文字（44–56）
# =====================================================================================
place_st(pad([B2, Fs3, A3, D4], 5.6, attack=1.0, release=2.0, cutoff=1400), 43.6, gain=0.19)
place_st(pad([G2, D3, A3, B3, Fs4], 5.6, attack=1.0, release=2.0, cutoff=1500), 47.6, gain=0.19)
place_st(pad([A2, E3, B3, E4, Fs4], 5.4, attack=1.0, release=1.6, cutoff=1900), 51.6, gain=0.19)
place(bass(B1, 4.2), 44.0, 0.34, 0, 0.1); place(bass(G2, 4.2), 48.0, 0.32, 0, 0.1); place(bass(A1, 4.2), 52.0, 0.30, 0, 0.1); place(bass(A2, 4.0), 52.0, 0.2, 0, 0.1)
for s, n in [(44.5, Fs4), (45.6, A4), (47.2, B4), (48.3, D5), (49.9, E5), (51.0, Fs5)]:  # 每一行字一个音，一路往上
    place(pluck(n, bright=0.6), s, 0.17, rng.uniform(-0.3, 0.3), 0.85)
    place(pluck(n - 12, bright=0.4), s, 0.07, rng.uniform(-0.3, 0.3), 0.85)
for i, (s, lo, hi) in enumerate([(52.2, A4, E5), (52.95, B4, Fs5), (53.7, D5, A5)]):  # ALIVE / AMUSE / AWAKE
    place(tom([A2, B2, D3][i]), s, 0.30, [-0.4, 0.0, 0.4][i], 0.35)
    place(pluck(lo), s, 0.18, [-0.4, 0.0, 0.4][i], 0.7); place(pluck(hi), s, 0.15, [-0.4, 0.0, 0.4][i], 0.7)
place(swell(1.7, 300, 6000, 2.6), 54.3, 0.12, 0.0, 0.5)

# =====================================================================================
# 六、口号（56–64）
# =====================================================================================
for i, s in enumerate((56.0, 57.0, 58.0)):
    place(kick(f1=110, f2=42), s, 0.50, 0, 0.05)
    place(bass(D2, 3.0), s, 0.36 - i * 0.05, 0, 0.08)
    chord = [[D4, A4], [D4, Fs4, A4], [D4, Fs4, A4, E5, D6]][i]
    for n in chord:
        place(pluck(n, bright=1.0 + 0.2 * i), s, 0.15, rng.uniform(-0.5, 0.5), 0.7)
place_st(pad([D3, A3, D4, Fs4, A4, E5], 8.4, attack=0.3, release=2.6, cutoff=2600), 56.0, gain=0.21)
place(bowl(D5, 5.0, 1.8), 58.0, 0.12, 0.0, 0.8)
for bar in (56.0, 60.0):
    last = bar == 60.0
    groove(bar, kicks=(1, 2, 3) if not last else (0, 1, 2), shakes=8, claps=(), level=0.9 if not last else 0.75)
    seq = [(0.5, A5), (1.0, Fs5), (1.5, A5), (2.0, E5), (2.5, A5), (3.0, Fs5), (3.5, D5)]
    mel(bar, seq if not last else seq[:5], gain=0.14 if not last else 0.11, bright=0.9)
place(bass(D2, 3.6), 60.0, 0.34, 0, 0.08)

# =====================================================================================
# 七、落版（64–72）
# =====================================================================================
place_st(pad([D3, A3, E4, A4], 7.6, attack=1.2, release=4.2, cutoff=1600), 63.6, gain=0.20)
place(bass(D2, 6.0), 64.25, 0.36, 0, 0.1)
for s, n, p in [(64.25, Fs5, -0.4), (64.45, A5, 0.0), (64.65, B5, 0.4)]:  # 字标里的三横
    place(pluck(n), s, 0.17, p, 0.75); place(drop(midi(n), 0.3), s, 0.06, p, 0.8)
for s, n in [(64.9, D3), (65.1, A3)]:  # 山立起来
    place(wood(n + 12), s, 0.22, 0.2, 0.5); place(pluck(n, bright=0.5), s, 0.14, 0.2, 0.6)
for n, p in [(D5, -0.25), (A5, 0.25)]:
    place(pluck(n, bright=0.8), 66.3, 0.14, p, 0.85)
place(bowl(D4, 8.0, 2.8), 66.8, 0.26, 0.0, 0.7)

# ---------- 混响、总线 ----------
def reverb_ir(rt60=2.9, d=3.6):
    t = tt(d)
    ir = np.zeros((len(t), 2))
    for ch in (0, 1):
        x = rng.standard_normal(len(t)) * np.exp(-6.91 * t / rt60)
        x = lp(hp(x, 180), 5200)
        # 高频衰减得更快
        x = x * 0.6 + lp(x, 1600) * 0.8
        pre = int(0.018 * SR)
        ir[pre:, ch] = x[:-pre]
    return ir / np.sqrt((ir ** 2).sum(axis=0)).max()


ir = reverb_ir()
rev = np.stack([signal.fftconvolve(wet[:, ch], ir[:, ch])[:N] for ch in (0, 1)], axis=1)
mix = dry + rev * 0.9
for ch in (0, 1):
    mix[:, ch] = hp(mix[:, ch], 35)
    mix[:, ch] = mix[:, ch] + 0.8 * hp(mix[:, ch], 2400, 1) + 0.5 * hp(mix[:, ch], 6000, 1)

# 开头 30 毫秒、结尾 1.6 秒收干净
tfull = np.arange(N) / SR
mix *= (np.clip(tfull / 0.03, 0, 1) * np.clip((DUR - 0.25 - tfull) / 1.6, 0, 1) ** 1.3)[:, None]

# 轻轻压一下峰值，再把整体放到合适的音量（最后由渲染脚本按响度再校一次）
peak = np.abs(mix).max()
mix = np.tanh(mix / peak * 1.35) / np.tanh(1.35)
mix *= 0.89 / np.abs(mix).max()

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.wav')
import wave
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(3); w.setframerate(SR)
    pcm = np.clip(mix, -1, 1)
    i32 = (pcm * (2 ** 23 - 1)).astype('<i4')
    b = i32.astype('<i4').tobytes()
    # 取每个 32 位整数的低 3 个字节，写成 24 位
    arr = np.frombuffer(b, dtype=np.uint8).reshape(-1, 4)[:, :3]
    w.writeframes(arr.tobytes())
rms = np.sqrt((mix ** 2).mean())
print(f'wrote {out}  {DUR:.0f}s  peak {20 * np.log10(np.abs(mix).max()):.1f} dBFS  rms {20 * np.log10(rms):.1f} dBFS')
