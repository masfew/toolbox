"""Generated icons for whitelisted apps in the flyout: a one-colour glyph traced from
the app's own icon, on the app's brand colour.

The app's icon is read from its exe at 64 px. If most of it is one colour (a
coloured plate behind a logo, as with Discord and Spotify), that colour is the brand
colour and the logo, the part that differs from the plate, becomes the glyph. If not,
the icon's outline is the glyph. When no glyph can be traced (the outline is a plain
blob, as with Chrome's circle), the app's own full-colour icon is used as it is; with
no icon at all, the app's first letter. Results are cached under
~/.claude/wispr-mute/icons/, keyed on the exe's path and modification time.
"""

import base64
import ctypes
import json
import math
from collections import Counter
from ctypes import wintypes
from pathlib import Path

import wispr_mute as w
from win32 import *  # noqa: F401,F403

ICON_DIR = w.DATA_DIR / "icons"
SOURCE = 64      # px read from the exe
GLYPH_RES = 64   # px of the stored glyph mask
CACHE_VERSION = 2
FALLBACK_COLOR = (96, 96, 112)


# --- reading an exe's icon and name -----------------------------------------------

def exe_icon_rgba(path, size=SOURCE):
    """The exe's main icon as (width, height, [(r, g, b, a) 0-255]), or None."""
    icon = wintypes.HICON()
    try:
        shell32.SHDefExtractIconW(str(path), 0, 0, ctypes.byref(icon), None, size | (16 << 16))
    except OSError:
        return None
    if not icon:
        return None
    info = ICONINFO()
    try:
        if not user32.GetIconInfo(icon, ctypes.byref(info)) or not info.hbmColor:
            return None
        bitmap = BITMAP()
        gdi32.GetObjectW(info.hbmColor, ctypes.sizeof(BITMAP), ctypes.byref(bitmap))
        width, height = bitmap.bmWidth, bitmap.bmHeight
        colour = _dib_bits(info.hbmColor, width, height)
        if not any(colour[3::4]):  # no alpha channel: transparency comes from the mask
            mask = _dib_bits(info.hbmMask, width, height)
            for i in range(width * height):
                colour[i * 4 + 3] = 0 if mask[i * 4] else 255
        pixels = [(colour[i + 2], colour[i + 1], colour[i], colour[i + 3]) for i in range(0, len(colour), 4)]
        return width, height, pixels
    finally:
        for handle in (info.hbmColor, info.hbmMask):
            if handle:
                gdi32.DeleteObject(handle)
        user32.DestroyIcon(icon)


def _dib_bits(bitmap, width, height):
    header = BITMAPINFO256()
    header.bmiHeader = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=width, biHeight=-height,
                                        biPlanes=1, biBitCount=32)
    buffer = ctypes.create_string_buffer(width * height * 4)
    hdc = user32.GetDC(None)
    gdi32.GetDIBits(hdc, bitmap, 0, height, buffer, ctypes.byref(header), DIB_RGB_COLORS)
    user32.ReleaseDC(None, hdc)
    return bytearray(buffer.raw)


def file_description(path):
    """The exe's "File description" (what Task Manager shows, e.g. "Discord"), or None."""
    try:
        size = versiondll.GetFileVersionInfoSizeW(str(path), None)
        if not size:
            return None
        data = ctypes.create_string_buffer(size)
        if not versiondll.GetFileVersionInfoW(str(path), 0, size, data):
            return None
        pointer, length = ctypes.c_void_p(), wintypes.UINT()
        if not versiondll.VerQueryValueW(data, r"\VarFileInfo\Translation", ctypes.byref(pointer),
                                         ctypes.byref(length)) or length.value < 4:
            return None
        lang, codepage = ctypes.cast(pointer, ctypes.POINTER(wintypes.WORD * 2)).contents
        query = rf"\StringFileInfo\{lang:04x}{codepage:04x}\FileDescription"
        if not versiondll.VerQueryValueW(data, query, ctypes.byref(pointer), ctypes.byref(length)) or not length.value:
            return None
        # The reported length is in characters for some exes and bytes for others, so
        # read that much and stop at the first terminator.
        text = ctypes.wstring_at(pointer, length.value).split("\0", 1)[0].strip()
        return text or None
    except OSError:
        return None


def find_exe(exe):
    """Path of a running process with this exe name, or None."""
    paths = sorted(w.running_exe_paths(exe))
    return paths[0] if paths else None


# --- turning an icon into a glyph and a colour --------------------------------------

def _distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a[:3], b[:3])))


def analyse(width, height, pixels):
    """{"color": (r, g, b), "mask": GLYPH_RES² bytes}, or {"color", "image": (side, RGBA
    bytes)} when no glyph can be traced."""
    opaque = [p for p in pixels if p[3] >= 128]
    if len(opaque) < width * height * 0.05:
        return None
    buckets = Counter((p[0] >> 5, p[1] >> 5, p[2] >> 5) for p in opaque)
    top = buckets.most_common(1)[0][0]
    members = [p for p in opaque if (p[0] >> 5, p[1] >> 5, p[2] >> 5) == top]
    plate = tuple(round(sum(p[i] for p in members) / len(members)) for i in range(3))
    plate_share = sum(1 for p in opaque if _distance(p, plate) < 60) / len(opaque)

    if plate_share >= 0.45:  # a coloured plate behind a logo: the logo is what differs from it
        coverage = [p[3] / 255 * max(0.0, min(1.0, (_distance(p, plate) - 45) / 60)) for p in pixels]
        mask = _crop_square(width, height, coverage, reject_blobs=False)
    else:  # the icon is the shape itself; its outline only works if it isn't a plain blob
        coverage = [p[3] / 255 for p in pixels]
        mask = _crop_square(width, height, coverage, reject_blobs=True)
    colour = plate
    if mask is None:
        return {"color": colour, "image": _crop_image(width, height, pixels)}
    return {"color": colour, "mask": mask}


def _crop_image(width, height, pixels):
    """The icon itself, cropped to its visible part and centred in a transparent
    square: (side, RGBA bytes)."""
    xs = [i % width for i, p in enumerate(pixels) if p[3] >= 16]
    ys = [i // width for i, p in enumerate(pixels) if p[3] >= 16]
    left, right, top, bottom = min(xs), max(xs) + 1, min(ys), max(ys) + 1
    side = max(right - left, bottom - top)
    ox, oy = left - (side - (right - left)) // 2, top - (side - (bottom - top)) // 2
    out = bytearray(side * side * 4)
    for y in range(side):
        for x in range(side):
            sx, sy = ox + x, oy + y
            if 0 <= sx < width and 0 <= sy < height:
                out[(y * side + x) * 4:(y * side + x) * 4 + 4] = bytes(pixels[sy * width + sx])
    return side, bytes(out)


def image_bgra(image, grey=False, opacity=1.0):
    """A cropped icon as BGRA bytes for GDI+, optionally in greyscale and faded."""
    side, rgba = image
    out = bytearray(len(rgba))
    for i in range(0, len(rgba), 4):
        r, g, b, a = rgba[i:i + 4]
        if grey:
            r = g = b = round(0.2126 * r + 0.7152 * g + 0.0722 * b)
        out[i:i + 4] = bytes((b, g, r, round(a * opacity)))
    return bytes(out)


def _crop_square(width, height, coverage, reject_blobs):
    """Crop the glyph to its bounds, centre it in a square and scale it to GLYPH_RES.
    None when it's too small, or (with reject_blobs) a shape that fills its bounds,
    like a round or square icon's outline, which would read as a plain shape."""
    xs = [i % width for i, c in enumerate(coverage) if c > 0.5]
    ys = [i // width for i, c in enumerate(coverage) if c > 0.5]
    if len(xs) < width * height * 0.03:
        return None
    left, right, top, bottom = min(xs), max(xs) + 1, min(ys), max(ys) + 1
    box_w, box_h = right - left, bottom - top
    fill = sum(coverage[y * width + x] for y in range(top, bottom) for x in range(left, right)) / (box_w * box_h)
    if reject_blobs and fill > 0.72:
        return None
    side = max(box_w, box_h)
    out = bytearray(GLYPH_RES * GLYPH_RES)
    scale = side / GLYPH_RES
    ox, oy = left - (side - box_w) / 2, top - (side - box_h) / 2
    for gy in range(GLYPH_RES):
        y0, y1 = oy + gy * scale, oy + (gy + 1) * scale
        for gx in range(GLYPH_RES):
            x0, x1 = ox + gx * scale, ox + (gx + 1) * scale
            total = area = 0.0
            for y in range(math.floor(y0), math.ceil(y1)):
                wy = min(y + 1, y1) - max(y, y0)
                for x in range(math.floor(x0), math.ceil(x1)):
                    wx = min(x + 1, x1) - max(x, x0)
                    if 0 <= x < width and 0 <= y < height:
                        total += coverage[y * width + x] * wx * wy
                    area += wx * wy
            out[gy * GLYPH_RES + gx] = round(255 * total / area) if area else 0
    return bytes(out)


def scaled_mask(mask, size):
    """The stored GLYPH_RES mask area-averaged down to size x size, as 0..1 floats."""
    out, step = [], GLYPH_RES / size
    for y in range(size):
        y0, y1 = y * step, (y + 1) * step
        for x in range(size):
            x0, x1 = x * step, (x + 1) * step
            total = area = 0.0
            for sy in range(math.floor(y0), min(GLYPH_RES, math.ceil(y1))):
                wy = min(sy + 1, y1) - max(sy, y0)
                for sx in range(math.floor(x0), min(GLYPH_RES, math.ceil(x1))):
                    wx = min(sx + 1, x1) - max(sx, x0)
                    total += mask[sy * GLYPH_RES + sx] / 255 * wx * wy
                    area += wx * wy
            out.append(total / area if area else 0.0)
    return out


def ink_for(colour):
    """White glyphs on dark or saturated colours, near-black on light ones."""
    luminance = (0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2]) / 255
    return (24, 24, 24) if luminance > 0.62 else (255, 255, 255)


# --- the cache -------------------------------------------------------------------------

def app_icon(exe, path):
    """{"color", "ink", "mask", "image" or "letter"} for a whitelisted app; generated
    once per exe version and cached. When the exe is gone (the app updated into a new
    version folder and isn't running yet to tell us where), the last cached icon is
    kept; with none, a grey letter tile."""
    letter = (exe[:1] or "?").upper()
    cache = ICON_DIR / f"{w.app_key(exe)}.json"
    if not path or not Path(path).is_file():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            if data.get("version") == CACHE_VERSION:
                return _from_cache(data, letter)
        except (OSError, ValueError):
            pass
        return {"color": FALLBACK_COLOR, "ink": (255, 255, 255), "letter": letter}
    stamp = int(Path(path).stat().st_mtime)
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("version") == CACHE_VERSION and data.get("path") == str(path) and data.get("stamp") == stamp:
            return _from_cache(data, letter)
    except (OSError, ValueError):
        pass
    icon = exe_icon_rgba(path)
    result = analyse(*icon) if icon else None
    data = {"version": CACHE_VERSION, "path": str(path), "stamp": stamp,
            "color": list(result["color"]) if result else list(FALLBACK_COLOR)}
    if result and "mask" in result:
        data["mask"] = base64.b64encode(result["mask"]).decode("ascii")
    elif result and "image" in result:
        data["image_size"], image = result["image"]
        data["image"] = base64.b64encode(image).decode("ascii")
    try:
        ICON_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass
    return _from_cache(data, letter)


def _from_cache(data, letter):
    colour = tuple(data["color"])
    icon = {"color": colour, "ink": ink_for(colour)}
    if "mask" in data:
        icon["mask"] = base64.b64decode(data["mask"])
    elif "image" in data:
        icon["image"] = (data["image_size"], base64.b64decode(data["image"]))
    else:
        icon["letter"] = letter
    return icon
