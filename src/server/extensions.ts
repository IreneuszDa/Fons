import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "better-sqlite3";
import type { EngineLlmProvider } from "../engine/llm/types";
import type { ChannelAdapter, RetrievalBranch } from "../shared/contracts";
import type { AppConfig } from "./config";

export interface FonsExtensions {
  /** Change when adapter behaviour or source selection changes, to invalidate cached reports. */
  version: string;
  models?: { main: EngineLlmProvider; verifier?: EngineLlmProvider };
  branches?: RetrievalBranch[];
  channels?: ChannelAdapter[];
}

/** Only the operator can configure this local module at process startup. */
export async function loadExtensions(cfg: AppConfig, db: Database): Promise<FonsExtensions | undefined> {
  const path = cfg.extensionsModule;
  if (!path) return;
  const module = await import(pathToFileURL(resolve(path)).href);
  if (typeof module.createExtensions !== "function") throw new Error("Moduł rozszerzeń musi eksportować createExtensions.");
  const extension: FonsExtensions = await module.createExtensions({ cfg, db });
  if (typeof extension?.version !== "string" || !extension.version.trim()) throw new Error("Brak wersji modułu rozszerzeń.");
  return extension;
}
