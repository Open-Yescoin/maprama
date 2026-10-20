# Run Maprama Locally

These commands use npm workspaces from the repository root. Ports `5173` and `5174` are intentionally avoided.

## 1. Install dependencies

```sh
npm install --prefer-offline --no-audit --no-fund
```

## 2. Build the packages needed for local development

```sh
npm run build -w @open-yescoin/maprama-protocol
npm run build -w @open-yescoin/maprama-engine-web
npm run build -w @open-yescoin/maprama-react-native
npm run build -w @open-yescoin/maprama-api
npm run typecheck -w @open-yescoin/maprama-example
```

If you also need the OSM or tiles CLIs, run the full build:

```sh
npm run build
```

## 3. Start the local API

```sh
npm run dev:local -w @open-yescoin/maprama-api -- --port 8787 --world seongsu=../../tools/osm/samples/seongsu.world.json
```

Copy the printed `client key`.

## 4. Start the Expo example app

Use the client key from the API server:

```sh
EXPO_PUBLIC_MAPRAMA_API_KEY=mpr_xxx npm run start -w @open-yescoin/maprama-example -- --localhost
```

Metro runs at:

```text
http://localhost:8081
```

## 5. Start the docs and playground on port 5175

Run this from the `docs/` directory so VitePress uses the right site root:

```sh
cd docs
npm run gen
npx vitepress dev . --port 5175
```

Open:

```text
http://localhost:5175/
```

## Notes

- Do not use `npm run docs:dev` when `5174` is occupied; that script hardcodes port `5174`.
- The iOS simulator flow requires full Xcode, not just Command Line Tools.
- Expo may rewrite `example/tsconfig.json#include` while starting Metro. Review that file before committing; the change is usually formatting-only.
