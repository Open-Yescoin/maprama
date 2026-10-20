# Publishing Maprama packages

The Open-Yescoin fork is the source of `@open-yescoin/maprama-protocol` and `@open-yescoin/maprama-engine-web`. Consumers install exact versions from npm. Do not copy package source or tarballs into consumer repositories.

## Release order

1. Merge the source and version changes to `main`. CI must pass the build, typecheck, tests and docs build on Node 22 and 24.
2. Publish `@open-yescoin/maprama-protocol` first, then `@open-yescoin/maprama-engine-web`. The engine package declares the matching protocol version as a dependency.
3. Confirm both public registry entries and install them in a clean directory. Check the package exports and the installed protocol version.
4. Update each consumer's exact dependency versions and lockfile. Verify frozen installs and builds in a clean Linux environment before deploying dev.
5. Test the dev city editing, publication, map rendering, building labels and character avatars. Deploy prod only after dev passes.

Publishing is a release decision, not part of every commit. A Maprama change can be developed and tested without publishing until consumers need it. For later releases, bump both package versions together and run the `npm-release.yml` workflow from `main` after configuring npm trusted publishing for both packages. This workflow uses GitHub OIDC and does not store a long-lived npm token.

Published npm versions are immutable. Fixes require a new version; never replace a tarball at the same version.
