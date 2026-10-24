"""Tray icons for the Wispr Mute: Wispr Flow's own tray icon with a small
badge in the corner showing whether dictation mutes audio. Pure Python (standard
library only). The speaker glyphs (glyph, coverage) are also drawn in the flyout.

The base image is read from the installed Wispr Flow (resources/assets/tray/
TrayIconWindows.png), so it follows Wispr Flow's updates; if it can't be found, a
plain dark rounded square stands in. Images are lists of (r, g, b, a) floats 0..1,
row by row, drawn at the exact pixel size the tray wants, with 4x4 supersampling.
"""

import math
import os
import re
import struct
import zlib
from pathlib import Path

WISPR_DIR = Path(os.environ.get("LOCALAPPDATA", "")) / "WisprFlow"
WISPR_TRAY_PNG = Path("resources") / "assets" / "tray" / "TrayIconWindows.png"

# Badge colours (r, g, b) and glyph per tray state.
BADGES = {
    "muting": ((0.898, 0.282, 0.302), "speaker_x"),          # red: muting (whitelisted apps aside)
    "audible": ((0.55, 0.55, 0.58), "speaker_wave"),         # grey: muting switched off (Audible)
    "stopped": ((0.961, 0.647, 0.141), "exclaim"),           # amber: the helper isn't running
}
SAMPLES = 4  # supersampling per axis


# --- reading Wispr Flow's icon --------------------------------------------------

def wispr_tray_png():
    """Path of TrayIconWindows.png in the newest installed Wispr Flow version, or None."""
    def version(path):
        return tuple(int(n) for n in re.findall(r"\d+", path.name))
    try:
        folders = sorted((p for p in WISPR_DIR.glob("app-*") if p.is_dir()), key=version, reverse=True)
    except OSError:
        return None
    for folder in folders:
        if (folder / WISPR_TRAY_PNG).is_file():
            return folder / WISPR_TRAY_PNG
    return None


def decode_png(data):
    """Decode an 8-bit RGBA, non-interlaced PNG to (width, height, pixels 0..1)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, header = 8, b"", None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
    width, height, depth, colour, _, _, interlace = header
    if (depth, colour, interlace) != (8, 6, 0):
        raise ValueError("only 8-bit RGBA, non-interlaced PNGs are supported")
    raw, stride, bpp = zlib.decompress(idat), width * 4, 4
    rows, prev, pos = [], bytearray(stride), 0
    for _ in range(height):
        kind, line = raw[pos], bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if kind == 1:
                line[i] = (line[i] + a) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + b) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        rows.append(line)
        prev = line
    pixels = [tuple(v / 255 for v in row[x * 4:x * 4 + 4]) for row in rows for x in range(width)]
    return width, height, pixels


def resample(width, height, pixels, size):
    """Area-average an image to size x size (alpha-weighted, so edges don't darken)."""
    out = []
    sx, sy = width / size, height / size
    for oy in range(size):
        y0, y1 = oy * sy, (oy + 1) * sy
        for ox in range(size):
            x0, x1 = ox * sx, (ox + 1) * sx
            acc = [0.0, 0.0, 0.0, 0.0]
            area = 0.0
            for y in range(int(y0), min(height, math.ceil(y1))):
                wy = min(y + 1, y1) - max(y, y0)
                for x in range(int(x0), min(width, math.ceil(x1))):
                    w = wy * (min(x + 1, x1) - max(x, x0))
                    r, g, b, a = pixels[y * width + x]
                    acc[0] += r * a * w
                    acc[1] += g * a * w
                    acc[2] += b * a * w
                    acc[3] += a * w
                    area += w
            a = acc[3] / area
            out.append((acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], a) if acc[3] else (0, 0, 0, 0))
    return out


def fallback_base(size):
    """A dark rounded square, for when Wispr Flow's icon can't be read."""
    def inside(x, y):
        r = 0.22
        dx, dy = max(abs(x - 0.5) - (0.5 - r), 0), max(abs(y - 0.5) - (0.5 - r), 0)
        return dx * dx + dy * dy <= r * r
    return [(0.12, 0.12, 0.16, a) for a in coverage(size, inside, 0, 0, size)]


def base_image(size):
    path = wispr_tray_png()
    if path is not None:
        try:
            return resample(*decode_png(path.read_bytes()), size)
        except (OSError, ValueError, ZeroDivisionError, TypeError, struct.error, zlib.error):
            pass
    return fallback_base(size)


# --- drawing the badge ------------------------------------------------------------

def coverage(size, inside, left, top, span):
    """Fraction of each pixel (of a size x size image) covered by a shape.

    `inside(u, v)` takes coordinates in 0..1 across a box `span` pixels wide whose
    top-left corner is pixel (left, top).
    """
    out = []
    step = 1 / SAMPLES
    for py in range(size):
        for px in range(size):
            hits = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    u = (px + (sx + 0.5) * step - left) / span
                    v = (py + (sy + 0.5) * step - top) / span
                    if 0 <= u <= 1 and 0 <= v <= 1 and inside(u, v):
                        hits += 1
            out.append(hits / (SAMPLES * SAMPLES))
    return out


def near_segment(x, y, ax, ay, bx, by, half_width):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    ex, ey = x - (ax + t * dx), y - (ay + t * dy)
    return ex * ex + ey * ey <= half_width * half_width


def in_polygon(x, y, points):
    inside = False
    j = len(points) - 1
    for i, (xi, yi) in enumerate(points):
        xj, yj = points[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


SPEAKER = [(0.20, 0.40), (0.33, 0.40), (0.52, 0.22), (0.52, 0.78), (0.33, 0.60), (0.20, 0.60)]


def glyph(kind):
    """The white mark inside the badge, as inside(u, v) over the badge's 0..1 box."""
    if kind == "speaker_x":
        def inside(u, v):
            return (in_polygon(u, v, SPEAKER)
                    or near_segment(u, v, 0.61, 0.38, 0.81, 0.62, 0.055)
                    or near_segment(u, v, 0.61, 0.62, 0.81, 0.38, 0.055))
    elif kind == "speaker_wave":
        def inside(u, v):
            r = math.hypot(u - 0.50, v - 0.50)
            on_arc = abs(r - 0.24) <= 0.055 and u > 0.58 and abs(v - 0.5) <= 0.19
            return in_polygon(u, v, SPEAKER) or on_arc
    else:  # exclaim
        def inside(u, v):
            return near_segment(u, v, 0.5, 0.24, 0.5, 0.56, 0.07) or math.hypot(u - 0.5, v - 0.75) <= 0.075
    return inside


def render(state, size):
    """Wispr Flow's icon with the badge for `state`, as size*size (r, g, b, a) floats.

    The badge sits in the bottom-right corner at a bit over half the icon's width,
    small enough that Wispr Flow's bars stay recognisable.
    """
    pixels = base_image(size)
    colour, kind = BADGES[state]
    diameter = max(8.0, size * 0.55)
    gap = max(1.0, size * 0.07)
    centre = size - diameter / 2
    left = centre - diameter / 2 - gap

    def disc(radius):
        def inside(u, v):
            span = diameter + 2 * gap
            x, y = u * span + left, v * span + left
            return math.hypot(x - centre, y - centre) <= radius
        return inside

    span = diameter + 2 * gap
    cut = coverage(size, disc(diameter / 2 + gap), left, left, span)
    fill = coverage(size, disc(diameter / 2), left, left, span)
    mark = glyph(kind)
    badge_left = centre - diameter / 2
    white = coverage(size, mark, badge_left, badge_left, diameter)
    glyph_rgb = (0.12, 0.10, 0.05) if state == "stopped" else (1.0, 1.0, 1.0)

    out = []
    for i, (r, g, b, a) in enumerate(pixels):
        a *= 1 - cut[i]  # transparent ring around the badge, so it reads at 16 px
        # badge disc over the base, then the glyph over the disc ("over" compositing)
        for (cr, cg, cb), ca in ((colour, fill[i]), (glyph_rgb, min(white[i], fill[i]))):
            if ca:
                na = ca + a * (1 - ca)
                r = (cr * ca + r * a * (1 - ca)) / na
                g = (cg * ca + g * a * (1 - ca)) / na
                b = (cb * ca + b * a * (1 - ca)) / na
                a = na
        out.append((r, g, b, a))
    return out


def to_bgra(pixels):
    """Straight-alpha BGRA bytes, top row first, as CreateIconIndirect wants them."""
    out = bytearray()
    for r, g, b, a in pixels:
        out += bytes((round(b * 255), round(g * 255), round(r * 255), round(a * 255)))
    return bytes(out)
