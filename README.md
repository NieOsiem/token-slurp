# Token Slurp

Module for switching token images and wildcard without reliance on actor data.

## Install

In Foundry VTT, open **Add-on Modules → Install Module**, paste this URL into the **Manifest URL** field, and click **Install**:

```text
https://github.com/NieOsiem/token-slurp/releases/latest/download/module.json
```

No manual repository clone is required.

## Compatibility

Foundry VTT v12 through v14.

## License

GPL-3.0. See [LICENSE](LICENSE).

## Releasing

1. Bump `version` in `module.json`.
2. Commit and push the change.
3. Push a matching tag:

```bash
git tag -a vX.Y.Z -m "Token Slurp vX.Y.Z"
git push origin vX.Y.Z
```

GitHub Actions validates the tag against `module.json`, builds `token-slurp.zip`, and publishes the release assets.