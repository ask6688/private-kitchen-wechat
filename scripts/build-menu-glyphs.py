#!/usr/bin/env python3
"""Build the Menu Canvas outline atlas; build dependencies: fonttools, brotli.

Usage: python scripts/build-menu-glyphs.py FONT.ttf[.br] OUTPUT.br

The output is a Brotli quality-11 stream. Its decompressed binary format is
little-endian, with no alignment or padding:

Header (24 bytes): <4sHHhhhHII
  magic="MGP1", unitsPerEm, coordinateScale=2, ascent, descent, lineGap,
  reserved=0, recordCount, dataOffset.
Records (16 bytes each, sorted by codepoint): <IHhII
  Unicode codepoint, advance, yMax, byteOffset, byteLength.
  advance/yMax and the header metrics use original font units. byteOffset is
  relative to dataOffset. Codepoint 0 supplies the font's .notdef outline.

Each glyph is a sequence of one-byte opcodes followed by coordinate pairs:
  0: closePath (0 points)
  1: moveTo (1 point)
  2: lineTo (1 point)
  3: quadraticCurveTo (1 control point and 1 endpoint)
  4: bezierCurveTo (2 control points and 1 endpoint)
  5..255: quadratic chain (opcode-3 control points, then 1 endpoint).
For a quadratic chain, intermediate endpoints are the midpoints between
adjacent control points. The final curve uses the explicitly stored endpoint.

Coordinates are deltas from the previous serialized point, starting at (0, 0)
for each glyph. closePath does NOT reset the delta accumulator. For each x/y
delta, read int8: values other than -128 mean delta*2; -128 is followed by an
int16 containing the delta directly. Accumulated coordinates are in half font
units; divide by coordinateScale=2 to obtain original font coordinates (y up).
This preserves half-unit TrueType points without rounding them to whole units.

The builder verifies every decoded command against the original decomposed
outline, all cmap entries and the compressed stream before writing the result.
Font licensing remains in miniprogram/fonts/OFL.json.
"""

import argparse
import hashlib
import io
import struct
from pathlib import Path

import brotli
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont


HEADER = struct.Struct("<4sHHhhhHII")
RECORD = struct.Struct("<IHhII")
COORDINATE_SCALE = 2


class OutlinePen(BasePen):
    """BasePen decomposes composite glyphs and implied quadratic points."""

    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.commands = []
        self.max_quantization_error = 0
        self.open_contour = False

    def command(self, opcode, points=()):
        quantized = []
        for point in points:
            encoded = tuple(round(value * COORDINATE_SCALE) for value in point)
            self.max_quantization_error = max(
                self.max_quantization_error,
                *(abs(value - integer / COORDINATE_SCALE)
                  for value, integer in zip(point, encoded)),
            )
            quantized.append(encoded)
        self.commands.append((opcode, quantized))

    def _moveTo(self, point):
        if self.open_contour:
            raise ValueError("A glyph starts a contour before closing the last")
        self.open_contour = True
        self.command(1, (point,))

    def _lineTo(self, point):
        self.command(2, (point,))

    def _qCurveToOne(self, control, endpoint):
        self.command(3, (control, endpoint))

    def _curveToOne(self, control1, control2, endpoint):
        self.command(4, (control1, control2, endpoint))

    def _closePath(self):
        if not self.open_contour:
            raise ValueError("A glyph closes a contour before starting it")
        self.open_contour = False
        self.command(0)

    def _endPath(self):
        raise ValueError("Open font contours cannot be represented by this atlas")


def encode_outline(commands):
    compact = []
    for opcode, points in commands:
        if opcode == 3 and compact and compact[-1][0] == 3:
            previous = compact[-1][1]
            if len(previous) < 253 and all(
                previous[-1][axis] * 2 == previous[-2][axis] + points[0][axis]
                for axis in (0, 1)
            ):
                previous[-1:] = points
                continue
        compact.append((opcode, list(points)))

    output = bytearray()
    x = y = 0
    for opcode, points in compact:
        if opcode == 3 and len(points) > 2:
            opcode = len(points) + 2
        output.append(opcode)
        for next_x, next_y in points:
            for delta in (next_x - x, next_y - y):
                if delta % 2 == 0 and -254 <= delta <= 254:
                    output.extend(struct.pack("<b", delta // 2))
                else:
                    output.append(128)
                    output.extend(struct.pack("<h", delta))
            x, y = next_x, next_y
    return output


def decode_outline(data):
    """Independent decoder used to check command geometry before shipping."""
    position = 0
    x = y = 0
    commands = []

    def read_delta():
        nonlocal position
        value = struct.unpack_from("<b", data, position)[0]
        position += 1
        if value == -128:
            value = struct.unpack_from("<h", data, position)[0]
            position += 2
            return value
        return value * 2

    while position < len(data):
        opcode = data[position]
        position += 1
        count = (0, 1, 1, 2, 3)[opcode] if opcode < 5 else opcode - 2
        points = []
        for _ in range(count):
            x += read_delta()
            y += read_delta()
            points.append((x, y))
        if opcode == 3 or opcode >= 5:
            for index, control in enumerate(points[:-1]):
                endpoint = points[-1] if index == len(points) - 2 else tuple(
                    (a + b) / 2 for a, b in zip(control, points[index + 1])
                )
                commands.append((3, [control, endpoint]))
        else:
            commands.append((opcode, points))
    if position != len(data):
        raise ValueError("Glyph command stream ends inside a coordinate")
    return commands


def build(source, destination):
    font_bytes = source.read_bytes()
    if source.suffix == ".br":
        font_bytes = brotli.decompress(font_bytes)
    font = TTFont(io.BytesIO(font_bytes))
    cmap = font.getBestCmap()
    if not cmap:
        raise ValueError("The source font has no Unicode cmap")
    original_coverage = set(cmap)
    cmap = dict(cmap)
    if 0 in cmap and cmap[0] != ".notdef":
        raise ValueError("Codepoint 0 is reserved for the .notdef outline")
    cmap[0] = ".notdef"
    glyph_set = font.getGlyphSet()
    records = bytearray()
    outlines = bytearray()
    max_error = 0
    command_count = 0

    for codepoint, name in sorted(cmap.items()):
        pen = OutlinePen(glyph_set)
        glyph_set[name].draw(pen)
        if pen.open_contour:
            raise ValueError(f"Unclosed contour in U+{codepoint:04X}")
        encoded = encode_outline(pen.commands)
        if decode_outline(encoded) != pen.commands:
            raise ValueError(f"Outline round-trip mismatch in U+{codepoint:04X}")
        glyph = font["glyf"][name]
        glyph.recalcBounds(font["glyf"])
        records.extend(RECORD.pack(
            codepoint, font["hmtx"][name][0], getattr(glyph, "yMax", 0),
            len(outlines), len(encoded),
        ))
        outlines.extend(encoded)
        command_count += len(pen.commands)
        max_error = max(max_error, pen.max_quantization_error)

    header = HEADER.pack(
        b"MGP1", font["head"].unitsPerEm, COORDINATE_SCALE,
        font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap,
        0, len(cmap), HEADER.size + len(records),
    )
    raw = header + records + outlines
    stored_coverage = {
        RECORD.unpack_from(raw, HEADER.size + index * RECORD.size)[0]
        for index in range(len(cmap))
    }
    if stored_coverage != original_coverage | {0}:
        raise ValueError("The atlas does not preserve the source cmap")
    compressed = brotli.compress(raw, quality=11)
    if brotli.decompress(compressed) != raw:
        raise ValueError("Brotli round-trip mismatch")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(compressed)
    print(f"Wrote {destination}: {len(compressed):,} bytes ({len(raw):,} decoded)")
    print(f"Coverage: {len(original_coverage):,} Unicode characters + .notdef")
    print(f"Verified {command_count:,} decomposed commands; "
          f"maximum coordinate rounding: {max_error:g} font units")
    print(f"SHA-256: {hashlib.sha256(compressed).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source TrueType font (.ttf or .ttf.br)")
    parser.add_argument("output", type=Path, help="Destination Brotli atlas (.br)")
    arguments = parser.parse_args()
    build(arguments.source, arguments.output)
