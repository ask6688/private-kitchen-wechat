# Menu lettering

`kitchen-menu-glyphs.br` contains Canvas outlines derived from the horizontal subset of [LXGW WenKai v1.522](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522), Regular. SIL OFL 1.1 copyright and license remain in `OFL.json`, included in the code package.

The atlas covers 6,897 Unicode characters (GB2312 Chinese, ASCII and common punctuation), plus the source .notdef glyph. Coordinates preserve the original quadratic contours with no rounding loss. Characters outside the atlas use the platform font without changing user text.

The renderer reads this allowed `.br` package resource with `readCompressedFile`, then measures glyph advances and draws ordinary Canvas paths. It does not call `wx.loadFontFace`, register a font, inspect rendered font pixels, or download a remote asset. Native font decoding and registration no longer decide whether a Menu can be exported. Local file read/parse failures still end the loading state and allow retry.

Build with `python scripts/build-menu-glyphs.py FONT.ttf[.br] OUTPUT.br` using Python fontTools and brotli; neither is an app runtime dependency. The script documents the MGP1 binary format and verifies every decoded contour against the source. Source subset: 6,897 mappings, 1,000 units/em, renamed KitchenMenuWenkaiTTF. Atlas: 1,738,541 compressed bytes. Keep the original source and the license when rebuilding; do not ship a second native font asset.

A local Canvas render verifies geometry and lettering independently of font registration. This is not a substitute for checking the generated package on a phone.
