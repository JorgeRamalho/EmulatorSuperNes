import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = path.join(
  root,
  "games",
  "roms",
  "donkey-kong-country-usa.sfc",
);
const downloadsSource = "C:\\Users\\jorge\\Downloads\\Donkey Kong Country (USA).sfc";

const gameId = "donkey-kong-country-usa";
const source = fs.existsSync(defaultSource)
  ? defaultSource
  : fs.existsSync(downloadsSource)
    ? downloadsSource
    : null;

if (!source) {
  console.error(
    "ROM não encontrada. Coloque donkey-kong-country-usa.sfc em games/roms/ ou no Downloads.",
  );
  process.exit(1);
}

const rom = fs.readFileSync(source);
const outDir = path.join(root, "games", "embedded");
const outFile = path.join(outDir, `${gameId}.js`);

fs.mkdirSync(outDir, { recursive: true });

const body = `/* ROM embutida para deploy estático (Vercel). Gerado por scripts/embed-rom.mjs — não edite. */
globalThis.__BANCADA_EMBEDDED_ROMS__ = Object.assign(globalThis.__BANCADA_EMBEDDED_ROMS__ || {}, {
  "${gameId}": "${rom.toString("base64")}",
});
`;

fs.writeFileSync(outFile, body, "utf8");
console.log(`Embutido ${rom.length} bytes → ${path.relative(root, outFile)}`);
