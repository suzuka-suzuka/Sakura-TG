import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { resolveConfigValue } from "./configValue.js";
import {
  ensureAiDataDirectory,
  vertexCredentialRoot,
} from "./paths.js";

export const DEFAULT_VERTEX_LOCATION = "global";

export function getManagedVertexCredentialPath(reference) {
  const normalized = String(reference || "").trim();
  if (!normalized || !/^[a-zA-Z0-9._-]+$/.test(normalized)) return null;

  const candidate = path.join(vertexCredentialRoot, `${normalized}.json`);
  return fs.existsSync(candidate) ? candidate : null;
}

function existingPath(value) {
  const configured = String(resolveConfigValue(value) || "").trim();
  if (!configured) return null;
  const candidate = path.resolve(configured);
  return fs.existsSync(candidate) ? candidate : null;
}

export function getVertexCredentialPath(config = {}) {
  const managedReference =
    config.serviceAccountRef || config.credentialRef;
  if (managedReference) {
    return getManagedVertexCredentialPath(managedReference);
  }

  return (
    existingPath(config.credentialsFile) ||
    existingPath(config.googleApplicationCredentials) ||
    existingPath(config.keyFilename) ||
    existingPath(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

export function readJsonCredentialFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function buildGeminiClientOptions(config = {}) {
  const baseURL = String(config.baseURL || config.baseUrl || "").trim();
  const isVertex = config.vertex === true || config.vertexai === true;
  const options = {};

  if (isVertex) {
    const filePath = getVertexCredentialPath(config);
    const credential = readJsonCredentialFile(filePath);
    const project =
      config.project ||
      config.vertexProject ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      credential?.project_id;
    const location =
      config.location ||
      config.vertexLocation ||
      process.env.GOOGLE_CLOUD_LOCATION ||
      process.env.GOOGLE_VERTEX_LOCATION ||
      DEFAULT_VERTEX_LOCATION;

    if (!filePath || !project) {
      throw new Error(
        `Vertex 凭据不可用：请把服务账号 JSON 放入 ${vertexCredentialRoot}，并在配置中填写 serviceAccountRef`
      );
    }

    options.vertexai = true;
    options.project = project;
    options.location = location;
    options.googleAuthOptions = { keyFilename: filePath };
  } else {
    const apiKey = String(resolveConfigValue(config.apiKey || config.api) || "");
    if (!apiKey) throw new Error("Gemini API Key 不能为空");
    options.apiKey = apiKey;
  }

  if (baseURL) options.httpOptions = { baseUrl: baseURL };
  return options;
}

export function createGeminiClient(config = {}) {
  return new GoogleGenAI(buildGeminiClientOptions(config));
}

export function ensureVertexCredentialDirectory() {
  return ensureAiDataDirectory(vertexCredentialRoot);
}
