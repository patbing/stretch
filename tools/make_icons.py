#!/usr/bin/env python3
"""Generate the STRETCH extension icons (pure stdlib PNG writer).

The mark: a short bar and a longer bar — the "stretch" idea in one glyph.
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

BG = (13, 17, 23, 255)        # #0d1117
ACCENT = (138, 180, 248, 255)  # #8ab4f8
WHITE = (230, 237, 243, 255)


def png(width, height, pixels):
    raw = b""
    for y in range(height):
        flat = [v for px in pixels[y] for v in px]
        raw += b"\x00" + bytes(flat)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def draw(size):
    px = [[BG for _ in range(size)] for _ in range(size)]
    pad = max(1, size // 8)
    r = max(2, size // 6)  # corner radius
    # rounded rect background
    for y in range(size):
        for x in range(size):
            inside = True
            for cx, cy in ((r, r), (size - 1 - r, r), (r, size - 1 - r), (size - 1 - r, size - 1 - r)):
                if (x < r and y < r and (cx == r and cy == r and (x - cx) ** 2 + (y - cy) ** 2 > r * r)
                        or (x > size - 1 - r and y < r and (cx == size - 1 - r and cy == r and (x - cx) ** 2 + (y - cy) ** 2 > r * r))
                        or (x < r and y > size - 1 - r and (cx == r and cy == size - 1 - r and (x - cx) ** 2 + (y - cy) ** 2 > r * r))
                        or (x > size - 1 - r and y > size - 1 - r and (cx == size - 1 - r and cy == size - 1 - r and (x - cx) ** 2 + (y - cy) ** 2 > r * r))):
                    inside = False
            if inside:
                px[y][x] = BG

    def bar(x0, x1, y, h, color):
        for yy in range(max(0, y), min(size, y + h)):
            for xx in range(max(0, x0), min(size, x1)):
                px[yy][xx] = color

    bar(pad, pad + max(2, size // 5), size // 2 - max(1, size // 12), max(2, size // 12), WHITE)
    bar(pad, pad + max(3, (size - 2 * pad) // 2), size // 2 + max(1, size // 12), max(2, size // 12), ACCENT)
    return px


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        px = draw(size)
        data = png(size, size, px)
        path = os.path.join(OUT, "icon%d.png" % size)
        with open(path, "wb") as f:
            f.write(data)
        print("wrote", path, len(data), "bytes")


if __name__ == "__main__":
    main()
