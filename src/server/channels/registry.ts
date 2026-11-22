import type { ChannelAdapter } from "../../shared/contracts";
import { cliAdapter } from "./cli";
import { webAdapter } from "./web";

export interface ChannelRegistry {
  /** webhook=true: kanał przyjmuje wiadomości przez POST /api/channels/:id/webhook. */
  register(adapter: ChannelAdapter, opts?: { webhook?: boolean }): void;
  get(id: string): ChannelAdapter | undefined;
  /** Adapter skonfigurowany do webhooka; undefined → 501 (nieznany lub nieskonfigurowany). */
  getWebhook(id: string): ChannelAdapter | undefined;
  list(): ChannelAdapter[];
}

export function createChannelRegistry(): ChannelRegistry {
  const adapters = new Map<string, { adapter: ChannelAdapter; webhook: boolean }>();
  const registry: ChannelRegistry = {
    register(adapter, opts) {
      adapters.set(adapter.id, { adapter, webhook: opts?.webhook ?? false });
    },
    get: (id) => adapters.get(id)?.adapter,
    getWebhook(id) {
      const e = adapters.get(id);
      return e?.webhook ? e.adapter : undefined;
    },
    list: () => [...adapters.values()].map((e) => e.adapter),
  };
  registry.register(webAdapter);
  registry.register(cliAdapter);
  // ChatLoom dostarcza odpowiedzi w odpowiedzi HTTP na webhook. Jego trasę rejestruje createApp.
  return registry;
}
