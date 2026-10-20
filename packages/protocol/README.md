# @open-yescoin/maprama-protocol

The shared contract between Maprama engines and hosts: TypeScript types for
worlds, themes, characters, drops and labels, the command/event message codec
with runtime validation, geo projection and the theme presets.

Install this package directly to build world data, write an engine or host, or
use the types and presets on a server. Browser hosts can use it alongside
`@open-yescoin/maprama-engine-web`.

```sh
npm i @open-yescoin/maprama-protocol
```

## Usage

```ts
import {
  encodeCommand, decodeEvent, validateWorldData, createProjection, PRESETS,
  type EngineCommand, type WorldData,
} from '@open-yescoin/maprama-protocol';

const wire = encodeCommand({ type: 'setCamera', camera: { pitch: 45 } }, 1);

const result = validateWorldData(json);
if (!result.ok) console.warn(result.error);
```

Theme presets are also published as JSON:

```ts
import urban from '@open-yescoin/maprama-protocol/themes/urban.json';
```

## Contents

- **World data** (`WorldData`): buildings, roads, POIs, stations, districts,
  water and parks in world units, plus validation.
- **Messages**: every engine command and event, `encodeCommand` /
  `decodeCommand`, `encodeEvent` / `decodeEvent` and validators.
  `PROTOCOL_VERSION` is `1`.
- **Geo**: projection between longitude/latitude and world space.
- **Themes**: `realistic`, `urban`, `modern`, `toy`, `minimal` and `soft`
  presets, time-of-day and cinematic settings.
- **Entities and labels**: characters, drops, travel modes, geofences and
  label styles.

The package is ESM only, has no runtime dependencies and no side effects.

## Links

- [Repository and documentation](https://github.com/Open-Yescoin/maprama)
- [Changelog](https://github.com/Open-Yescoin/maprama/blob/main/CHANGELOG.md)

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
