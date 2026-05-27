# @vibecontrols/vibe-plugin-gitops-bitbucket

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
