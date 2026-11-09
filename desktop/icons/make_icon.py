#!/usr/bin/env python3
"""Consilium icon: the particle iris.

A dotted silver torus with one bright arc, spectral glints, a faint
orbit-ellipse echo of the in-app mark, comb-tick rays and bloom on a
true-black squircle with a thin steel rim. Small sizes use a simplified
variant (ring and glint), not a downscale.

Regenerate the shipped icons from the repository root:

    python3 desktop/icons/make_icon.py
"""
import numpy as np
from PIL import Image, ImageFilter

RNG = np.random.default_rng(7)
S = 1024
H = S / 2

# ── palette (matches ui tokens) ─────────────────────────────────────────
VOID_TOP = np.array([0, 0, 0], float)
VOID_BOT = np.array([0, 0, 0], float)
RIM = np.array([52, 56, 66], float)
SILVER = np.array([216, 222, 238], float)
SPECTRAL = [  # angle-keyed accents, low saturation base world
    (np.array([154, 120, 255], float)),   # violet
    (np.array([104, 190, 232], float)),   # blue-teal
    (np.array([90, 219, 232], float)),    # teal
    (np.array([225, 228, 240], float)),   # silver-white
    (np.array([232, 190, 110], float)),   # gold
    (np.array([224, 130, 212], float)),   # magenta
]


def squircle_mask(size, n=4.6, extent=0.94, ss=4):
    """Antialiased superellipse alpha mask."""
    m = size * ss
    y, x = np.mgrid[0:m, 0:m]
    cx = (m - 1) / 2
    u = (np.abs(x - cx) / (extent * m / 2)) ** n + (np.abs(y - cx) / (extent * m / 2)) ** n
    hard = (u <= 1.0).astype(np.float32)
    img = Image.fromarray((hard * 255).astype(np.uint8)).resize((size, size), Image.LANCZOS)
    return np.asarray(img).astype(np.float32) / 255.0


def splat(buf, px, py, sigma, rgb, gain):
    """Additive gaussian splat, vectorized window write."""
    r = max(2, int(sigma * 3.2))
    x0, x1 = int(px) - r, int(px) + r + 1
    y0, y1 = int(py) - r, int(py) + r + 1
    if x1 <= 0 or y1 <= 0 or x0 >= S or y0 >= S:
        return
    xs = np.arange(max(0, x0), min(S, x1))
    ys = np.arange(max(0, y0), min(S, y1))
    gx = np.exp(-((xs - px) ** 2) / (2 * sigma * sigma))
    gy = np.exp(-((ys - py) ** 2) / (2 * sigma * sigma))
    g = np.outer(gy, gx) * gain
    buf[np.ix_(ys, xs)] += g[..., None] * (rgb / 255.0)


def spectral_color(theta, sat):
    """Angle → spectral accent mixed into silver by sat."""
    t = ((theta + np.pi) / (2 * np.pi)) * (len(SPECTRAL) - 1)
    i = int(np.clip(t, 0, len(SPECTRAL) - 2))
    f = t - i
    accent = SPECTRAL[i] * (1 - f) + SPECTRAL[i + 1] * f
    return SILVER * (1 - sat) + accent * sat


def master():
    # plate: vertical void gradient + faint warm lift low-center
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    tgrad = (yy / S)[..., None]
    plate = (VOID_TOP * (1 - tgrad) + VOID_BOT * tgrad) / 255.0

    field = np.zeros((S, S, 3), np.float32)

    # ── the iris: dotted torus, density peaks upper-right (light is earned)
    N = 5400
    theta0 = -np.pi / 4  # bright arc direction (upper right)
    thetas = []
    while len(thetas) < N:
        t = RNG.uniform(-np.pi, np.pi, 2048)
        w = 1.25 + 0.75 * np.cos(t - theta0) ** 3
        keep = t[RNG.uniform(0, 2.0, 2048) < w]
        thetas.extend(keep.tolist())
    thetas = np.array(thetas[:N])
    R0 = 0.295 * S
    tail = RNG.uniform(0, 1, N) < 0.14
    sig_r = np.where(tail, 0.085 * S, 0.026 * S)
    rr = RNG.normal(R0, sig_r)
    px = H + rr * np.cos(thetas)
    py = H + rr * np.sin(thetas) * 0.985
    size = 0.75 + 2.1 * RNG.power(3.2, N)          # few big, many fine
    bright = np.exp(RNG.normal(-1.15, 0.55, N))     # lognormal energy
    arc_boost = 1 + 1.15 * np.clip(np.cos(thetas - theta0), 0, 1) ** 3
    glint = RNG.uniform(0, 1, N) < 0.09
    for i in range(N):
        sat = 0.6 if glint[i] else 0.14
        gain = bright[i] * arc_boost[i] * (2.6 if glint[i] else 1.0) * 0.30
        rgb = spectral_color(thetas[i], sat)
        splat(field, px[i], py[i], size[i], rgb, gain)

    # ── orbit ellipse echo of the app mark, as a faint particle stream
    M = 1050
    et = RNG.uniform(-np.pi, np.pi, M)
    erx, ery, tilt = 0.415 * S, 0.16 * S, np.deg2rad(-27)
    ex = erx * np.cos(et) + RNG.normal(0, 1.8, M)
    ey = ery * np.sin(et) + RNG.normal(0, 1.8, M)
    exr = H + ex * np.cos(tilt) - ey * np.sin(tilt)
    eyr = H + ex * np.sin(tilt) + ey * np.cos(tilt)
    for i in range(M):
        splat(field, exr[i], eyr[i], 0.9, SILVER, 0.062)
    # satellite dot at the ellipse's rising vertex
    sx = H + erx * np.cos(np.deg2rad(-14)) * np.cos(tilt) - ery * np.sin(np.deg2rad(-14)) * np.sin(tilt)
    sy = H + erx * np.cos(np.deg2rad(-14)) * np.sin(tilt) + ery * np.sin(np.deg2rad(-14)) * np.cos(tilt)
    splat(field, sx, sy, 3.4, np.array([255, 244, 224], float), 1.9)
    splat(field, sx, sy, 10.0, np.array([232, 190, 110], float), 0.25)

    # ── comb rays: sparse measurement ticks just outside the torus
    for k in range(48):
        th = -np.pi + k * (2 * np.pi / 48)
        a0, a1 = 0.372 * S, 0.402 * S
        for rr2 in np.linspace(a0, a1, 9):
            splat(field, H + rr2 * np.cos(th), H + rr2 * np.sin(th) * 0.985, 0.75, SILVER, 0.04)

    # ── inner core wisp: near-dark violet dust, keeps the void center alive
    K = 260
    kr = np.abs(RNG.normal(0, 0.05 * S, K))
    kt = RNG.uniform(-np.pi, np.pi, K)
    for i in range(K):
        splat(field, H + kr[i] * np.cos(kt[i]), H + kr[i] * np.sin(kt[i]),
              1.1, np.array([154, 120, 255], float), 0.09)

    # ── bloom: bright-pass, two gaussian octaves (3× box blur ≈ gaussian)
    def box_axis(a, r, axis):
        n = a.shape[axis]
        a = np.moveaxis(a, axis, 0)
        p = np.concatenate([np.repeat(a[:1], r, 0), a, np.repeat(a[-1:], r, 0)], 0)
        c = np.cumsum(p, 0, dtype=np.float32)
        c = np.concatenate([np.zeros_like(c[:1]), c], 0)
        out = (c[2 * r + 1: 2 * r + 1 + n] - c[0:n]) / (2 * r + 1)
        return np.moveaxis(out, 0, axis)

    def blur(a, sigma):
        r = max(1, int(round(sigma * 0.72)))
        out = a
        for _ in range(3):
            out = box_axis(box_axis(out, r, 0), r, 1)
        return out

    bright_pass = np.clip(field - 0.30, 0, None)
    field = field + blur(bright_pass, 7) * 0.7 + blur(bright_pass, 26) * 1.1

    out = plate + field  # additive over void = screen-like

    # vignette (inside the plate) + film grain
    dv = np.sqrt((xx - H) ** 2 + (yy - H) ** 2) / H
    out *= (1 - 0.34 * np.clip(dv, 0, 1) ** 2.4)[..., None]

    alpha = squircle_mask(S)
    inner = squircle_mask(S, extent=0.94 - 2 * 6 / S)
    rim = np.clip(alpha - inner, 0, 1)
    out = out * (1 - rim[..., None]) + rim[..., None] * (RIM / 255.0)
    rgba = np.concatenate([np.clip(out, 0, 1), alpha[..., None]], -1)
    return Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA')


def simple(size):
    """Hand-simplified small variant: plate + ring + glint. No dust."""
    ss = 8
    m = size * ss
    y, x = np.mgrid[0:m, 0:m].astype(np.float32)
    c = (m - 1) / 2
    t = (y / m)[..., None]
    img = (VOID_TOP * (1 - t) + VOID_BOT * t) / 255.0

    d = np.sqrt((x - c) ** 2 + (y - c) ** 2)
    R = 0.30 * m
    w = 0.052 * m if size >= 32 else 0.065 * m
    ring = np.exp(-((d - R) ** 2) / (2 * (w / 2.355) ** 2))
    th = np.arctan2(y - c, x - c)
    arc = 1 + 1.3 * np.clip(np.cos(th + np.pi / 4), 0, 1) ** 2  # bright upper-right
    img += ring[..., None] * (SILVER / 255.0) * (arc[..., None]) * 0.62

    # glint dot upper-right, violet breath lower-left
    gx, gy = c + R * np.cos(-np.pi / 4), c + R * np.sin(-np.pi / 4)
    dg = np.sqrt((x - gx) ** 2 + (y - gy) ** 2)
    img += np.exp(-(dg ** 2) / (2 * (0.045 * m) ** 2))[..., None] * (np.array([255, 240, 214]) / 255.0) * 1.05
    vx, vy = c + R * np.cos(3 * np.pi / 4), c + R * np.sin(3 * np.pi / 4)
    dv2 = np.sqrt((x - vx) ** 2 + (y - vy) ** 2)
    img += np.exp(-(dv2 ** 2) / (2 * (0.05 * m) ** 2))[..., None] * (np.array([154, 120, 255]) / 255.0) * 0.5

    u = (np.abs(x - c) / (0.94 * m / 2)) ** 4.6 + (np.abs(y - c) / (0.94 * m / 2)) ** 4.6
    alpha = (u <= 1.0).astype(np.float32)
    rim_w = max(1.0, size / 64) * ss
    ui = (np.abs(x - c) / (0.94 * m / 2 - rim_w)) ** 4.6 + (np.abs(y - c) / (0.94 * m / 2 - rim_w)) ** 4.6
    rim = alpha * (ui > 1.0)
    img = img * (1 - rim[..., None]) + rim[..., None] * (RIM / 255.0)
    rgba = np.concatenate([np.clip(img, 0, 1), alpha[..., None]], -1)
    hi = Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA')
    return hi.resize((size, size), Image.LANCZOS)


SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="void" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#9a78ff" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#d8deee" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#fff4de"/>
    </linearGradient>
  </defs>
  <path d="M32 1.5c22.4 0 30.5 8.1 30.5 30.5S54.4 62.5 32 62.5 1.5 54.4 1.5 32 9.6 1.5 32 1.5Z" fill="url(#void)" stroke="#343842" stroke-width="1"/>
  <circle cx="32" cy="32" r="19" fill="none" stroke="url(#ring)" stroke-width="3.1"/>
  <circle cx="45.4" cy="18.6" r="3" fill="#fff4de"/>
  <circle cx="18.6" cy="45.4" r="2.2" fill="#9a78ff" opacity="0.6"/>
</svg>
'''


if __name__ == '__main__':
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    tauri_icons = root / 'desktop' / 'src-tauri' / 'icons'
    big = master()
    big.resize((256, 256), Image.LANCZOS).save(tauri_icons / 'icon.png')
    big.resize((256, 256), Image.LANCZOS).save(root / 'desktop' / 'icons' / 'consilium-appgrid.png')
    sizes = {s: big.resize((s, s), Image.LANCZOS) for s in (256, 128, 64, 48)}
    sizes.update({s: simple(s) for s in (32, 24, 16)})
    sizes[256].save(tauri_icons / 'icon.ico', sizes=[(s, s) for s in sorted(sizes)],
                    append_images=[sizes[s] for s in sorted(sizes) if s != 256])
    (root / 'desktop' / 'icons' / 'consilium.svg').write_text(SVG)
    print('rendered icon.png, icon.ico, consilium-appgrid.png and consilium.svg')
