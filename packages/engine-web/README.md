# @open-yescoin/maprama-engine-web

The Maprama v1 render engine: a three.js 2.5D diorama map that implements the
[`@open-yescoin/maprama-protocol`](https://www.npmjs.com/package/@open-yescoin/maprama-protocol) message
contract. WebView hosts can load the bundled engine HTML; browser hosts can
import the ESM library directly.

```sh
npm i @open-yescoin/maprama-engine-web
```

## Usage in a browser

```ts
import { createEngine, createDirectTransport } from '@open-yescoin/maprama-engine-web';

const transport = createDirectTransport();
transport.onEvent((event) => console.log(event));
const engine = createEngine(document.getElementById('map')!, { transport });
transport.postCommand({
  type: 'init',
  world: { kind: 'procedural', layout: 'town' },
  theme: { base: 'urban' },
  labels: {},
  ui: {},
  locationSource: 'simulated',
});
```

## Entry points

### Unified labels (0.4)

`BuildingLabelOverlay` has been removed. Send authored places through the existing
`setLabels` command; they share the native index, styles, visibility switch and
marker / info-card collision exclusions. Keep label configuration and authored
entries in the same command because `setLabels` replaces the full specification.

```ts
transport.postCommand({ type: 'setLabels', labels: {
  enabled: true, includeBase: false, style: 'holo',
  entries: [
    { id: 'building:shop-1', buildingId: 'shop-1', title: 'Corner Coffee', icon: 'cafe' },
    { id: 'poi:park-1', coordinate: { lng: 126.98, lat: 37.56 }, title: 'Neighborhood Park', icon: 'park' },
  ],
} });
// label:press reports labelId, coordinate and, for roof anchors, buildingId.
```

`includeBase` defaults to true. An authored entry with the same id as a base POI
replaces it; removing that entry restores the base label. Authored entries are
also included in `labelsIndex` and support `setLabelContent`. Building anchors
follow the renderer's current roof, including replacement models and transforms.
Upgrade engine-web and protocol together. The C++ native engine's authored-label
rendering is not implemented in this release.

| Import | Contents |
| --- | --- |
| `@open-yescoin/maprama-engine-web` | ESM library (`three` and `@open-yescoin/maprama-protocol` are dependencies, not bundled). |
| `@open-yescoin/maprama-engine-web/engine-html` | `ENGINE_HTML`: a single-file HTML document with the engine and a WebView transport inlined, for WebView hosts. |
| `@open-yescoin/maprama-engine-web/engine.html` | The same document as a file. |
| `@open-yescoin/maprama-engine-web/iife` | Self-contained IIFE bundle exposing the global `MapramaEngine`. |

Draco-compressed models load their decoder from gstatic.com at runtime; it is
not bundled.

## Links

- [Repository and documentation](https://github.com/Open-Yescoin/maprama)
- [Changelog](https://github.com/Open-Yescoin/maprama/blob/main/CHANGELOG.md)

## License

Apache-2.0. See `LICENSE` and `NOTICE`. The bundled three.js code is MIT
licensed (see `NOTICE`). Map data © OpenStreetMap contributors, ODbL: apps that
show OpenStreetMap-derived worlds must display this attribution (the engine
draws it when `ui.attribution` is on).
