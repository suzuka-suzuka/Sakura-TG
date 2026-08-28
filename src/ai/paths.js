import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(here, "../..");
export const aiDataRoot = path.join(projectRoot, "data", "ai");
export const vertexCredentialRoot = path.join(
  aiDataRoot,
  "vertex-credentials"
);

export function ensureAiDataDirectory(directory = aiDataRoot) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
