import { readdirSync, readFileSync, statSync } from "node:fs";

import { basename, join } from "node:path";
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

const pathData = (svg: string) => [...svg.matchAll(/sd=["']([^"']+)["']/g)].map((m) => m[1]);

type HeadLink = { rel: string; href?: string; type?: string };
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
    const icon = headLinks().find((l) => l.rel === "icon");
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

  it("the two official files are present next to the sources", () => {
    const names = filesUnder(join(srcRoot, "assets", "brand")).map((f) => basename(f));
    expect(names).toEqual(
      expect.arrayContaining(["6toFit_logotype_Black_1.svg", "6toFit_logo_Black_1.svg"]),
    );
  });
});
