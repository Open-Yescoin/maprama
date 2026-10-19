# Consumer packages

Maprama is the only editable source for `@maprama/protocol` and `@maprama/engine-web`. Consumer repositories keep versioned tarballs so Cloudflare Pages and server builds use the exact tested bytes without a release-time download.

1. Commit the source in `Open-Yescoin/maprama` and ensure its CI passes (`npm ci`, build, typecheck and test).
2. Run `node scripts/pack-consumers.mjs` from that clean commit. It rebuilds protocol and engine-web and writes tarballs plus `manifest.json` under ignored `releases/maprama-<commit>/`.
3. Copy the same protocol tarball to `kindra-admin` and `self-admin`; copy engine-web to `self-admin` and `kiss-me-front`. `kiss-me-front` also needs the same protocol tarball. Set `file:` dependencies and regenerate each pnpm lockfile. Keep the manifest with each consumer's vendored files.
4. Verify each consumer from a clean checkout with `pnpm install --frozen-lockfile`, its typecheck and production build. The consumer manifest's source commit and SHA-256 values identify the release exactly.

Each change of package contents requires a new package version. Never replace an existing tarball while retaining its version. Update the backend before publishing city-map data that requires a new protocol command; deploy the Mini App engine before publishing that data to players. Roll back a consumer by restoring the previous package, manifest and lockfile together.
