import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist", "ui");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "ui", "app.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  outfile: resolve(outDir, "app.js"),
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

const [template, css, javascript] = await Promise.all([
  readFile(resolve(root, "ui", "index.html"), "utf8"),
  readFile(resolve(root, "ui", "styles.css"), "utf8"),
  readFile(resolve(outDir, "app.js"), "utf8"),
]);

const safeCss = css.replaceAll("</style", "<\\/style");
const safeScript = javascript.replaceAll("</script", "<\\/script");

const html = template
  .replace("/*__STYLES__*/", () => safeCss)
  .replace("/*__SCRIPT__*/", () => safeScript);

await writeFile(resolve(outDir, "workbench.html"), html, "utf8");
await rm(resolve(outDir, "app.js"), { force: true });
console.log(`Built workbench UI (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB)`);
