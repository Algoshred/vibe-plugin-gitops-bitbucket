/**
 * @vibecontrols/vibe-plugin-gitops-bitbucket
 *
 * Bitbucket Cloud provider plugin.
 */
import {
  BoundLogger,
  createLifecycleHooks,
  ProviderRegistry,
  TelemetryEmitter,
} from "@vibecontrols/plugin-sdk";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";

import { BitbucketProvider } from "./provider.js";

const PLUGIN_NAME = "gitops-bitbucket";
const PLUGIN_VERSION = "0.1.0";
const PROVIDER_NAME = "bitbucket";

let provider: BitbucketProvider | null = null;

export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const telemetry = new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION);
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "gitops.provider.ready",
    onInit: async (hostServices: HostServices) => {
      const log = new BoundLogger(hostServices.logger, PLUGIN_NAME);
      provider = new BitbucketProvider(hostServices);
      await provider.init();
      new ProviderRegistry(hostServices).registerProvider(
        "gitops",
        PROVIDER_NAME,
        provider,
      );
      telemetry.emit("gitops.provider.ready", { provider: PROVIDER_NAME });
      log.info("Bitbucket gitops provider registered");
    },
    onShutdown: async () => {
      provider = null;
    },
  });
  return {
    capabilities: {
      storage: "rw",
      secrets: "rw",
      telemetry: true,
      audit: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Bitbucket Cloud provider for the GitOps meta plugin (REST v2, app-password auth).",
    tags: ["backend", "provider", "integration"],
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;
export { BitbucketProvider } from "./provider.js";
export type * from "./types.js";
