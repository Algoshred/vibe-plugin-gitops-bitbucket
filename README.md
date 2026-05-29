# @vibecontrols/vibe-plugin-gitops-bitbucket

<!-- VIBECONTROLS_OSS_HEADER_START -->

> **License**: MIT — see [LICENSE](./LICENSE).
> **Note**: This plugin is open source. The `@vibecontrols/agent` runtime that loads it is **not** open source — it is a proprietary product of Burdenoff Consultancy Services Pvt. Ltd. See [vibecontrols.com](https://vibecontrols.com) for the agent.

<!-- VIBECONTROLS_OSS_HEADER_END -->

Bitbucket Cloud provider for the [`@vibecontrols/vibe-plugin-gitops`](https://npmjs.com/package/@vibecontrols/vibe-plugin-gitops) meta plugin.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-gitops          # meta (once)
vibe plugin install @vibecontrols/vibe-plugin-gitops-bitbucket
```

## Auth

App password with these permissions (https://bitbucket.org/account/settings/app-passwords/):

- Repositories: read
- Pull requests: read
- Pipelines: read

```bash
vibe gitops auth set bitbucket "$BB_USERNAME:$BB_APP_PASSWORD"
```

PAT format: `username:app_password` (Basic auth). The username portion is your Bitbucket account name.

## Note

Bitbucket Server / on-prem (Data Center) is NOT supported in v1 — only Bitbucket Cloud (bitbucket.org).

## License

Proprietary — see LICENSE.

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **Bitbucket Cloud REST API** — <https://developer.atlassian.com/cloud/bitbucket/rest/>

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Important: agent is not open source

The `@vibecontrols/agent` runtime that loads and orchestrates these plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. Only the plugin contract and the plugins themselves are released under MIT. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
