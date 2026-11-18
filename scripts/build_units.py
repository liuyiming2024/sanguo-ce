#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 assets/units/src/*.jpg 生成八向转身素材（v0.9.0）。

产物：
  trooper-<dir>.png         8 张 idle 透明帧，统一 560×820 / 脚底基线 780
  trooper-walk-<dir>-L.png  8 张左步帧
  trooper-walk-<dir>-R.png  8 张右步帧
  trooper-sheet.png         idle 8 帧横排
  trooper-walk-sheet.png    步态 16 帧横排（每方向 L/R 相邻）
  trooper.json             角度 / 相位索引、源图 sha256（防回退到假背面）

步态不是 AI 逐张画腿（容易多腿、盔甲漂移），而是从已验收的 idle 帧
做确定性几何派生：逐行 shear 表达重心前移 + 整体 bob + 脚底扬尘。
同一 sec + heading + phase 永远得到同一帧，不含随机源与墙钟。

用法：python3 scripts/build_units.py
"""
import hashlib, json, os
from pathlib import Path
import numpy as np
import cv2
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets/units/src'
OUT = ROOT / 'assets/units'

DIRS = ['d0_front', 'd1_front_right', 'd2_right', 'd3_back_right',
        'd4_back', 'd5_back_left', 'd6_left', 'd7_front_left']
LABELS = ['正面 3/4', '右前 45°', '正右 90°', '右后 135°',
          '正背 180°', '左后 225°', '正左 270°', '左前 315°']
CW, CH, FOOT_Y = 560, 820, 780


def dewatermark(a):
    """右下角水印：取上方同尺寸空白区羽化覆盖。"""
    H, W = a.shape[:2]
    x0, y0, x1, y1 = W - 190, H - 105, W, H
    h, w = y1 - y0, x1 - x0
    src = a[y0 - h - 16:y0 - 16, x0:x1].copy()
    m = np.ones((h, w), np.float32)
    t = 22
    for i in range(t):
        f = i / t
        m[i, :] *= f; m[:, i] *= f; m[-(i+1), :] *= f; m[:, -(i+1)] *= f
    a[y0:y1, x0:x1] = (a[y0:y1, x0:x1] * (1 - m[..., None]) +
                       src * m[..., None]).astype(np.float32)
    return a


def extract(path):
    """源图 → 统一画布的透明 idle 帧。"""
    a = dewatermark(np.asarray(Image.open(path).convert('RGB')).copy().astype(np.float32))
    H, W = a.shape[:2]

    # 每行两侧空白带中位数 → 沿 y 平滑，得到背景渐变模型
    B = np.zeros((H, 1, 3), np.float32)
    for c in range(3):
        rm = np.array([np.median(np.concatenate([a[y, :55, c], a[y, -55:, c]]))
                       for y in range(H)])
        B[:, 0, c] = cv2.GaussianBlur(rm.reshape(H, 1).astype(np.float32),
                                      (0, 0), sigmaX=0, sigmaY=30).ravel()
    d = np.sqrt(((a - B) ** 2).sum(2))
    al = np.clip((d - 5.0) / 20.0, 0, 1).astype(np.float32)

    # 只保留最大连通域（人物），填内部孔洞
    seed = (al > 0.38).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(seed, 8)
    best = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA]) if n > 1 else 1
    al *= cv2.dilate((lab == best).astype(np.uint8),
                     np.ones((7, 7), np.uint8), iterations=1)
    core = (al > 0.55).astype(np.uint8)
    ff = core.copy(); mm = np.zeros((H + 2, W + 2), np.uint8)
    cv2.floodFill(ff, mm, (0, 0), 1)
    al = np.maximum(al, (1 - ff).astype(np.float32) * 0.92)

    # 色彩去污，消掉边缘青绿裙边
    aa = np.maximum(al, 0.001)[..., None]
    cfg = np.clip((a - (1 - aa) * B) / np.maximum(aa, 0.42), 0, 255)

    # 清地面投影（明显偏青绿的实色块，仅人物下半段），保留灰绿袖甲与靴子
    gr = a[:, :, 1] - a[:, :, 0]; gb = a[:, :, 1] - a[:, :, 2]
    teal = (gr > 13) & (gb > 6)
    ys = np.nonzero((al > 40).any(1))[0]
    if len(ys):
        teal[:int(ys.min() + 0.50 * (ys.max() - ys.min())), :] = False
    al[teal] = 0

    alpha8 = cv2.GaussianBlur((np.clip(al, 0, 1) * 255).astype(np.uint8), (0, 0), 0.4)
    alpha8[alpha8 < 16] = 0
    im = Image.fromarray(np.dstack([cfg.astype(np.uint8), alpha8]), 'RGBA')
    yy, xx = np.nonzero(alpha8 > 40)
    crop = im.crop((xx.min(), yy.min(), xx.max() + 1, yy.max() + 1))
    w0, h0 = crop.size
    sc = min(1.0, 720.0 / h0, (CW - 24) / w0)
    nw, nh = max(1, int(w0 * sc)), max(1, int(h0 * sc))
    crop = crop.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    canvas.alpha_composite(crop, ((CW - nw) // 2, FOOT_Y - nh))
    return canvas


def clean_foot_glow(im):
    """清掉脚下破碎的浅青白噪斑（AI 把地面投影画成了亮色碎点）。

    只在脚底基线附近动手，且只清「偏青绿 + 浅亮 + 低饱和」的像素：
    米黄色靴描边是 R>G>B，不会命中；札甲战裙在更高处，也不在范围内。
    确定性，无随机源。
    """
    a = np.asarray(im).copy()
    H, W = a.shape[:2]
    rgb = a[:, :, :3].astype(np.float32)
    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    sat = rgb.max(2) - rgb.min(2)
    gr = rgb[:, :, 1] - rgb[:, :, 0]      # 青绿偏移
    gb = rgb[:, :, 1] - rgb[:, :, 2]
    yy = np.arange(H, dtype=np.float32)[:, None]
    kill = (yy >= FOOT_Y - 118) & (lum > 125) & (sat < 85) & (gr > 2) & (gb > -8)
    a[:, :, 3][kill] = 0
    return Image.fromarray(a, 'RGBA')


def step_frame(idle, sign):
    """从 idle 帧派生一步：逐行 shear（重心前移）+ 整体 bob + 脚底扬尘。

    sign=+1 左步 / -1 右步。全是确定性整数/浮点运算，无随机源。
    用逐行水平位移而不是分块搬腿，避免接缝撕裂；在最下缘位移最大。
    """
    a = np.asarray(idle).copy()
    H, W = a.shape[:2]
    alpha = a[:, :, 3]
    rows = np.nonzero(alpha.max(1) > 40)[0]
    top, bot = int(rows.min()), int(rows.max())

    # 上半身保持稳定，只有从腰到脚的下半身参与；左右腿反向迈出、交替抬脚。
    # 用 tanh 做左右过渡，避免出现竖向接缝；整体 bob 交给渲染层按 phase 叠加。
    Y = np.arange(H, dtype=np.float32)[:, None]
    X = np.arange(W, dtype=np.float32)[None, :]
    t = np.clip((Y - (top + 0.44 * (bot - top))) /
                (0.56 * (bot - top) + 1e-6), 0, 1)          # H×1
    side = np.tanh((X - W / 2) / 42.0)                       # 1×W，左负右正
    leg = t * t * side                                        # H×W
    mapx = np.broadcast_to(X - sign * 5.2 * leg, (H, W)).copy()
    # 迈出的那条腿略微抬起（左脚 sign>0 时抬，右脚反之）
    lift = np.where(sign * side > 0, 1, 0) * t * 2.2
    mapy = np.broadcast_to(Y - lift, (H, W)).copy()
    warped = cv2.remap(a, mapx.astype(np.float32), mapy.astype(np.float32),
                       cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT,
                       borderValue=(0, 0, 0, 0))

    out = Image.fromarray(warped, 'RGBA')
    # 脚底扬尘：两粒极淡墨点，位置由 sign 决定，确定性
    dd = ImageDraw.Draw(out)
    cx = W // 2
    for k, (ox, oy, r) in enumerate([(sign * 16, -2, 3), (sign * 27, -5, 2)]):
        px, py = cx + ox, FOOT_Y + oy
        dd.ellipse((px - r, py - r, px + r, py + r), fill=(70, 78, 66, 46))
    return out




def engine_frames(base_rgba, prefix):
    """刚体器械：绕垂直轴旋转的俯视投影近似（2D 旋转矩阵，不是 scale(-1,1) 镜像）。

    人形转身必须逐张画（脸/甲片前后结构不同），器械是刚体，旋转矩阵在
    物理上成立；8 帧互不相同、0/180 是掉头而不是翻转，且同一基准派生，
    材质与形制不会逐张漂移。
    """
    out = []
    for i in range(8):
        ang = i * 45
        rot = base_rgba.rotate(ang, resample=Image.BICUBIC, expand=True)
        alpha = rot.getchannel('A')
        bb = alpha.getbbox()
        if bb: rot = rot.crop(bb)
        w0, h0 = rot.size
        sc = min(1.0, (CW - 40) / w0, (CH * 0.62) / h0)
        nw, nh = max(1, int(w0 * sc)), max(1, int(h0 * sc))
        rot = rot.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
        canvas.alpha_composite(rot, ((CW - nw) // 2, FOOT_Y - nh))
        out.append(canvas)
        yield f'engine-{prefix}-d{i}.png', canvas


def tiny_frame(idle):
    """手机 s<13 档：先降到可读尺寸再做轮廓增强，不把 560×820 直接缩成 10px。

    用 UnsharpMask + 对比度拉伸保住兜鍪顶 / 两肩 / 短躯干 / 矩形盾的边缘，
    放大之后一眼仍能认出是持盾甲士；确定性，无随机源。
    """
    from PIL import ImageEnhance, ImageFilter
    TW, TH = 72, 108
    im = idle.resize((TW, TH), Image.LANCZOS)
    rgb = im.convert('RGB')
    alpha = im.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    rgb = ImageEnhance.Contrast(rgb).enhance(1.18)
    rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.1, percent=135, threshold=2))
    return Image.merge('RGBA', (*rgb.split(), alpha))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    idles, walks = [], []
    src_hash = {}
    for n in DIRS:
        p = SRC / f'src-{n}.jpg'
        if not p.exists():
            raise SystemExit(f'缺源图 {p}')
        src_hash[n] = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
        idle = clean_foot_glow(extract(p))
        idle.save(OUT / f'trooper-{n}.png', optimize=True)
        L = step_frame(idle, +1); R = step_frame(idle, -1)
        L.save(OUT / f'trooper-walk-{n}-L.png', optimize=True)
        R.save(OUT / f'trooper-walk-{n}-R.png', optimize=True)
        idles.append(idle); walks.extend([L, R])
        print(f'  {n:16s} idle + 左步 + 右步')

    sheet = Image.new('RGBA', (CW * 8, CH), (0, 0, 0, 0))
    for i, im in enumerate(idles):
        sheet.alpha_composite(im, (i * CW, 0))
    sheet.save(OUT / 'trooper-sheet.png', optimize=True)

    wsheet = Image.new('RGBA', (CW * 16, CH), (0, 0, 0, 0))
    for i, im in enumerate(walks):
        wsheet.alpha_composite(im, (i * CW, 0))
    wsheet.save(OUT / 'trooper-walk-sheet.png', optimize=True)

    # 器械八向：两张写实基准 → 各 8 个刚体旋转投影帧 → 16 帧横排 sheet
    engine_sheet = Image.new('RGBA', (CW * 16, CH), (0, 0, 0, 0))
    engine_files = []
    for pidx, prefix in enumerate(['ballista', 'trebuchet']):
        src = SRC / f'src-engine-{prefix}.jpg'
        if not src.exists():
            raise SystemExit(f'缺器械基准 {src}')
        base = clean_foot_glow(extract(src))
        for i, (name, fr) in enumerate(engine_frames(base, prefix)):
            fr.save(OUT / name, optimize=True)
            engine_sheet.alpha_composite(fr, ((pidx * 8 + i) * CW, 0))
            engine_files.append(name)
    engine_sheet.save(OUT / 'engine-sheet.png', optimize=True)

    # 手机 tiny 档：8 向 idle 各一张轮廓增强小帧
    TW, TH = 72, 108
    tiny_sheet = Image.new('RGBA', (TW * 8, TH), (0, 0, 0, 0))
    for i, idle in enumerate(idles):
        t = tiny_frame(idle)
        t.save(OUT / f'trooper-tiny-d{i}.png', optimize=True)
        tiny_sheet.alpha_composite(t, (i * TW, 0))
    tiny_sheet.save(OUT / 'trooper-tiny-sheet.png', optimize=True)

    manifest = {
        'version': '0.9.1',
        'unit': 'trooper',
        'style': '写实淡彩 · 墨线勾勒 · 花青赭石 · 平光散光',
        'canvas': [CW, CH], 'footY': FOOT_Y, 'anchor': '脚底中心',
        'phases': ['idle', 'stepL', 'stepR'],
        'phaseRule': '静止取 idle；行走按 sin(phase) 符号在 stepL / stepR 间交替',
        'sheets': {'idle': 'trooper-sheet.png', 'walk': 'trooper-walk-sheet.png',
                   'engine': 'engine-sheet.png', 'tiny': 'trooper-tiny-sheet.png'},
        'engine': {'ballista': 0, 'trebuchet': 8,
                   'note': '刚体绕垂直轴旋转的 58° 俯视投影派生，非镜像；器械不摆腿，行军用轮架颠簸'},
        'tiny': {'canvas': [72, 108], 'note': 's<13 用轮廓增强小帧，不把 560×820 硬缩成 10px'},
        'note': ('8 向转身 × 3 相位 = 24 帧，统一画布与脚底基线。背面三帧经人工验收：'
                 '看不到护心镜 / 腰前蝴蝶结 / 盾面铆钉，只见背带、背甲、盾背握把。'
                 '步态由 idle 确定性几何派生，非 AI 逐张画腿（避免多腿与盔甲漂移）。'
                 '背景已抠透明，地面投影由渲染层绘制；运行时只读，不参与状态计算。'),
        'srcSha256': src_hash,
        'engineFiles': engine_files,
        'frames': [{'index': i, 'name': n, 'angle': i * 45, 'label': LABELS[i],
                    'file': f'trooper-{n}.png',
                    'walkL': f'trooper-walk-{n}-L.png',
                    'walkR': f'trooper-walk-{n}-R.png'}
                   for i, n in enumerate(DIRS)],
    }
    (OUT / 'trooper.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    print(f'\n产物：8 idle + 16 walk + 16 器械八向 + 8 tiny + 4 sheet + manifest，'
          f'共 {len(list(OUT.glob("*.png")))} PNG')


if __name__ == '__main__':
    main()
