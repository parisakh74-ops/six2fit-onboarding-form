import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";

import { basename, join } from "node:path";
import { inflateSync } from "node:zlib";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Logo } from "@/components/onboarding/shell";
import { Route } from "@/routes/__root";

// DEF-04: the logo and the favicon are bundled official brand files, not Lovable-hosted descriptors and not a
// root-level file that the hosting does not publish. Patterns are built from parts so this file does not match itself.
const LOVABLE_PATH = ["__l5", "e/assets-v1"].join("");
const ROOT_FAVICON = ["/favicon", ".png"].join("");
const srcRoot = join(process.cwd(), "src"); // vitest runs from the project root
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const PNG_NAME = "6toFit_logo_Black_1_64.png";
// SHA-256 of the committed fallback: the official mark rasterized once (docs/DEF-04_logo_favicon_integration_plan.md, section 9).
const PNG_SHA256 = "c6b21a6afa4a72fc0a2e6e8d052a7440d53ddf76beb111bf88c8e5b028d48aea";

/** Minimal PNG reader for 8-bit RGBA, non-interlaced files: enough to inspect the fallback without a raster library. */
function decodePng(buf: Buffer) {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]); // 8-bit, RGBA, not interlaced
    } else if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const cur = raw[y * (stride + 1) + 1 + i] ?? 0;
      const left = i >= 4 ? (px[y * stride + i - 4] ?? 0) : 0;
      const up = y > 0 ? (px[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= 4 ? (px[(y - 1) * stride + i - 4] ?? 0) : 0;
      const paeth = () => {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      };
      const add = [0, left, up, (left + up) >> 1, paeth()][filter] ?? 0;
      px[y * stride + i] = (cur + add) & 255;
    }
  }
  return { width, height, px };
}

const pathData = (svg: string) => [...svg.matchAll(/sd=["']([^"']+)["']/g)].map((m) => m[1]);

type HeadLink = { rel: string; href?: string; type?: string; sizes?: string };
const headLinks = (): HeadLink[] => {
  const head = Route.options.head as unknown as () => { links: HeadLink[] };
  return head().links;
};

describe("DEF-04 brand assets", () => {
  it("the header shows the bundled official logotype with the brand alt text", () => {
    const html = renderToStaticMarkup(<Logo />);
    expect(html).toMatch(/src="[^"]*6toFit_logotype_Black_1[^"]*\.svg"/);
    expect(html).toContain('alt="6toFit"');
    expect(html).not.toContain(LOVABLE_PATH);
  });

  it("the favicon link is the bundled official mark (SVG), not a root-level file", () => {
    const icon = headLinks().find((l) => l.rel === "icon" && l.type === "image/svg+xml");
    const href = icon?.href ?? "";
    expect(icon?.type).toBe("image/svg+xml");
    expect(href).not.toBe(ROOT_FAVICON);
    const prefix = "data:image/svg+xml,";
    if (href.startsWith(prefix)) {
      // Vite inlines assets smaller than 4 KB (the mark is 1.8 KB): compare the vector geometry with the official file.
      const official = readFileSync(
        join(srcRoot, "assets", "brand", "6toFit_logo_Black_1.svg"),
        "utf8",
      );
      expect(pathData(decodeURIComponent(href.slice(prefix.length)))).toEqual(pathData(official));
    } else {
      expect(href).toMatch(/6toFit_logo_Black_1[^/]*.svg$/);
    }
  });

  it("the PNG fallback link is a second icon link that points at the bundled official-mark PNG", () => {
    const icons = headLinks().filter((l) => l.rel === "icon");
    expect(icons.map((l) => l.type)).toEqual(["image/svg+xml", "image/png"]);
    const png = icons[1];
    expect(png?.sizes).toBe("64x64");
    const href = png?.href ?? "";
    expect(href).not.toBe(ROOT_FAVICON);
    expect(href).not.toContain(LOVABLE_PATH);
    // Vite inlines assets under 4 KB (this one is ~1.7 KB) as a data URI; a larger/future build would emit a hashed file.
    expect(
      href.startsWith("data:image/png;base64,") || /6toFit_logo_Black_1_64[^/]*[.]png$/.test(href),
    ).toBe(true);
    if (href.startsWith("data:")) {
      const bytes = Buffer.from(href.slice("data:image/png;base64,".length), "base64");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(PNG_SHA256);
    }
  });

  it("the PNG file is the official mark: 64x64 RGBA, brand colour #101010, centered, proportions 190:285", () => {
    const file = readFileSync(join(srcRoot, "assets", "brand", PNG_NAME));
    expect(createHash("sha256").update(file).digest("hex")).toBe(PNG_SHA256);
    const { width, height, px } = decodePng(file);
    expect([width, height]).toEqual([64, 64]);
    let [minX, minY, maxX, maxY] = [width, height, -1, -1];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if ((px[o + 3] ?? 0) < 128) continue;
        [minX, minY, maxX, maxY] = [
          Math.min(minX, x),
          Math.min(minY, y),
          Math.max(maxX, x),
          Math.max(maxY, y),
        ];
        // #101010; anti-aliased edge pixels may differ by rounding only
        const tolerance = px[o + 3] === 255 ? 0 : 2;
        for (const c of [px[o] ?? 0, px[o + 1] ?? 0, px[o + 2] ?? 0])
          expect(Math.abs(c - 16)).toBeLessThanOrEqual(tolerance);
      }
    const markW = maxX - minX + 1;
    const markH = maxY - minY + 1;
    expect(Math.abs(markW / markH - 190 / 285)).toBeLessThan(0.03); // official viewBox ratio
    expect(Math.abs(minX - (width - 1 - maxX))).toBeLessThanOrEqual(1); // horizontally centered
    expect(Math.abs(minY - (height - 1 - maxY))).toBeLessThanOrEqual(1); // vertically centered
    expect(px[3]).toBe(0); // transparent corner, no background fill
  });

  it("the sources contain no reference to the Lovable-hosted path anywhere in the icon configuration", () => {
    const text = JSON.stringify(headLinks());
    expect(text).not.toContain(LOVABLE_PATH);
  });

  it("no Lovable asset descriptor or hosted path remains in the sources", () => {
    const all = filesUnder(srcRoot);
    expect(all.filter((f) => f.endsWith(".asset.json"))).toEqual([]);
    const offenders = all
      .filter((f) => /\.(tsx?|css|json|md)$/.test(f))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return text.includes(LOVABLE_PATH) || text.includes(ROOT_FAVICON);
      });
    expect(offenders).toEqual([]);
  });

  it("the official files and the generated PNG are present next to the sources", () => {
    const names = filesUnder(join(srcRoot, "assets", "brand")).map((f) => basename(f));
    expect(names).toEqual(
      expect.arrayContaining(["6toFit_logotype_Black_1.svg", "6toFit_logo_Black_1.svg", PNG_NAME]),
    );
  });
});
