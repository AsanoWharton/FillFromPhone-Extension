import { readFile, writeFile, copyFile, rm, mkdir } from "node:fs/promises";
import { faMobileScreenButton } from "@fortawesome/free-solid-svg-icons";
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";
import { zipSync } from "fflate";

const productionOrigin = "https://remotefill.com";
const serviceOrigin = process.env.SERVICE_ORIGIN ?? productionOrigin;
const parsedOrigin = new URL(serviceOrigin);
if (parsedOrigin.origin !== serviceOrigin || !["https:", "http:"].includes(parsedOrigin.protocol)) throw new Error("invalid SERVICE_ORIGIN");
if (parsedOrigin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname)) {
  throw new Error("SERVICE_ORIGIN must use HTTPS outside localhost");
}

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await rm(new URL("./release", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("./dist", import.meta.url), { recursive: true });
await mkdir(new URL("./release", import.meta.url), { recursive: true });

// The package and store icon use the Font Awesome mobile-screen-button glyph under its published license.
const [iconWidth, iconHeight, , , iconPath] = faMobileScreenButton.icon;
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="22" fill="#146c68"/><path fill="#fff" transform="translate(41.5 34) scale(.1171875)" d="${iconPath}"/></svg>`;
if (iconWidth !== 384 || iconHeight !== 512 || typeof iconPath !== "string") throw new Error("unexpected Font Awesome icon definition");
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(iconSvg, { fitTo: { mode: "width", value: size } }).render().asPng();
  await writeFile(new URL(`./dist/icon-${size}.png`, import.meta.url), png);
}

const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
manifest.host_permissions = [`${serviceOrigin}/*`];
manifest.content_scripts = [{ matches: [`${serviceOrigin}/test`], js: ["presence.js"], run_at: "document_start" }];
await writeFile(new URL("./dist/manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
await Promise.all([
  writeFile(new URL("./dist/popup.html", import.meta.url), await readFile(new URL("./src/popup.html", import.meta.url))),
  writeFile(new URL("./dist/popup.css", import.meta.url), await readFile(new URL("./src/popup.css", import.meta.url))),
  copyFile(new URL("./node_modules/@fontsource/public-sans/files/public-sans-latin-400-normal.woff2", import.meta.url), new URL("./dist/public-sans-400.woff2", import.meta.url)),
  copyFile(new URL("./node_modules/@fontsource/public-sans/files/public-sans-latin-700-normal.woff2", import.meta.url), new URL("./dist/public-sans-700.woff2", import.meta.url)),
  copyFile(new URL("./node_modules/@fontsource/public-sans/LICENSE", import.meta.url), new URL("./dist/LICENSE-public-sans.txt", import.meta.url)),
  copyFile(new URL("./node_modules/qrcode/license", import.meta.url), new URL("./dist/LICENSE-qrcode.txt", import.meta.url)),
  copyFile(new URL("./node_modules/dijkstrajs/LICENSE.md", import.meta.url), new URL("./dist/LICENSE-dijkstrajs.txt", import.meta.url)),
  copyFile(new URL("./node_modules/@fortawesome/free-solid-svg-icons/LICENSE.txt", import.meta.url), new URL("./dist/LICENSE-font-awesome.txt", import.meta.url)),
  copyFile(new URL("./PROPRIETARY-NOTICE.txt", import.meta.url), new URL("./dist/PROPRIETARY-NOTICE.txt", import.meta.url))
]);

await Promise.all([
  build({
    entryPoints: [new URL("./src/background.ts", import.meta.url).pathname],
    outfile: new URL("./dist/background.js", import.meta.url).pathname,
    bundle: true,
    minify: true,
    sourcemap: false,
    format: "iife",
    target: "chrome120",
    define: { __SERVICE_ORIGIN__: JSON.stringify(serviceOrigin) },
    legalComments: "none"
  }),
  build({
    entryPoints: [new URL("./src/content.ts", import.meta.url).pathname],
    outfile: new URL("./dist/content.js", import.meta.url).pathname,
    bundle: true,
    minify: true,
    sourcemap: false,
    format: "iife",
    target: "chrome120",
    define: { __SERVICE_ORIGIN__: JSON.stringify(serviceOrigin) },
    legalComments: "none"
  }),
  build({
    entryPoints: [new URL("./src/popup.ts", import.meta.url).pathname],
    outfile: new URL("./dist/popup.js", import.meta.url).pathname,
    bundle: true,
    minify: true,
    sourcemap: false,
    format: "iife",
    target: "chrome120",
    define: { __SERVICE_ORIGIN__: JSON.stringify(serviceOrigin) },
    legalComments: "none"
  }),
  build({
    entryPoints: [new URL("./src/presence.ts", import.meta.url).pathname],
    outfile: new URL("./dist/presence.js", import.meta.url).pathname,
    bundle: true,
    minify: true,
    sourcemap: false,
    format: "iife",
    target: "chrome120",
    legalComments: "none"
  })
]);

const packageNames = ["manifest.json", "background.js", "content.js", "presence.js", "popup.html", "popup.css", "popup.js", "icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png", "public-sans-400.woff2", "public-sans-700.woff2", "LICENSE-public-sans.txt", "LICENSE-qrcode.txt", "LICENSE-dijkstrajs.txt", "LICENSE-font-awesome.txt", "PROPRIETARY-NOTICE.txt"];
const archiveTime = new Date("2026-01-01T00:00:00.000Z");
const packageEntries = Object.fromEntries(await Promise.all(packageNames.map(async (name) => [
  name,
  [new Uint8Array(await readFile(new URL(`./dist/${name}`, import.meta.url))), { mtime: archiveTime }]
])));
const archive = zipSync(packageEntries, { level: 9 });
await Promise.all([
  writeFile(new URL("./release/remote-fill-extension.zip", import.meta.url), archive),
  writeFile(new URL(`./release/remote-fill-${manifest.version}-chrome-web-store.zip`, import.meta.url), archive)
]);
