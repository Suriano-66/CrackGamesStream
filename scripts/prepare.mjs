// Copie three.js + cannon-es depuis node_modules → vendor/ (embarqué par l'app).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NM = path.join(ROOT, "node_modules");

const COPIES = [
  ["three/build/three.module.js", "vendor/three/build/three.module.js"],
  ["three/build/three.core.js", "vendor/three/build/three.core.js"],
  ["cannon-es/dist/cannon-es.js", "vendor/cannon-es/dist/cannon-es.js"],
];

let ok = 0;
for (const [rel, out] of COPIES) {
  try {
    const dest = path.join(ROOT, out);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(NM, rel), dest);
    ok++;
  } catch {
    console.warn(`⚠️  Introuvable: ${rel} — lance "npm install".`);
  }
}
console.log(`✅ Stream préparé : ${ok} fichier(s) vendorisé(s).`);
