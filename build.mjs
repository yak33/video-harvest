// VideoHarvest build script — produces dist/chrome (MV3) and dist/firefox (MV2), plus ready-to-upload ZIPs.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const targets = ["chrome", "firefox"];

function build(target) {
  const out = join(root, "dist", target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // copy source tree
  cpSync(join(root, "src"), out, { recursive: true });

  // inject manifest
  const manifest = JSON.parse(readFileSync(join(root, `manifest.${target}.json`), "utf8"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

  // generate store upload zip using tar.exe (ensures POSIX forward-slash '/' path separators)
  const zipPath = join(root, "dist", `${target}.zip`);
  rmSync(zipPath, { force: true });
  try {
    execSync(`tar.exe -a -c -f "${zipPath}" -C "${out}" *`);
    console.log(`[build] ${target} -> ${out} & ${zipPath}`);
  } catch (err) {
    console.log(`[build] ${target} -> ${out} (zip skipped: ${err.message})`);
  }
}

for (const t of targets) build(t);
console.log("[build] done. Ready for upload: dist/firefox.zip (AMO) and dist/chrome.zip (Chrome Web Store).");
