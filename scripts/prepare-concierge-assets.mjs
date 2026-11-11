// Source chunks keep model transfers bounded. Runtime still serves the complete, same-origin model/WASM.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname, sep } from "node:path";
const source = fileURLToPath(
  new URL("../src/client/concierge-assets/", import.meta.url),
);
const target = fileURLToPath(
  new URL("../src/client/public/concierge/ocr/", import.meta.url),
);
const manifest = JSON.parse(
  await readFile(resolve(source, "manifest.json"), "utf8"),
);
for (const item of manifest) {
  const destination = resolve(target, item.target);
  if (
    !destination.startsWith(target) ||
    !item.parts.every((p) => resolve(source, p).startsWith(source))
  )
    throw new Error("Unexpected concierge asset path");
  const check = (data) =>
    data.length === item.bytes &&
    createHash("sha256").update(data).digest("hex") === item.sha256;
  try {
    if (check(await readFile(destination))) continue;
  } catch {}
  const data = Buffer.concat(
    await Promise.all(item.parts.map((p) => readFile(resolve(source, p)))),
  );
  if (!check(data))
    throw new Error(`Concierge asset integrity check failed: ${item.target}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, data);
  console.log(`Verified local OCR asset: ${item.target}`);
}
