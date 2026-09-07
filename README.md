# minecraft-asset-loader

Fetch anything from any Minecraft: Java Edition version ever released, in Node.js and the browser. List versions, download assets, search files, and export whole versions.

[![npm version](https://badge.fury.io/js/minecraft-asset-loader.svg)](https://www.npmjs.com/package/minecraft-asset-loader)
[![jsDelivr](https://data.jsdelivr.com/v1/package/npm/minecraft-asset-loader/badge)](https://www.jsdelivr.com/package/npm/minecraft-asset-loader)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)

## Features

* Every version Mojang has published, from the earliest alphas to the latest snapshot
* Textures, models, blockstates, item definitions, sounds, structures, and languages
* Both resource pack and data pack assets included
* Search and filter files, with the best matches sorted first
* A built-in cache: download a version once, and later lookups are near instant
* Game code is never downloaded, so fetches are quick and exports stay small

## Install

For Node.js, or the browser through a bundler:

```bash
npm install minecraft-asset-loader
```

Or in the browser, import it straight from a [CDN](https://www.jsdelivr.com/package/npm/minecraft-asset-loader):

```js
import MinecraftAssets from "https://cdn.jsdelivr.net/npm/minecraft-asset-loader/+esm"
```

## Quick Start

```js
import MinecraftAssets from "minecraft-asset-loader"

const assets = new MinecraftAssets()

const png = await assets.getTexture("block/stone")            // png bytes
const model = await assets.getModel("block/stone")            // parsed json
const files = await assets.list("assets/minecraft/textures")  // every texture the version has
const hits = await assets.search("stone", { extension: "png" })
```

`version` is a version id, or one of three keywords, and defaults to `"release"`:

```js
new MinecraftAssets({ version: "26.1.2" })    // an exact version id
new MinecraftAssets({ version: "release" })   // the latest release, the default
new MinecraftAssets({ version: "snapshot" })  // the newest snapshot, even when a newer release exists
new MinecraftAssets({ version: "newest" })    // release or snapshot, whichever is newer
```

Every method also takes `{ version }` to request a specific version for that one call:

```js
const old = await assets.getTexture("blocks/stone", { version: "1.8.9" })
```

Nothing is fetched until a call needs it. Listing a version costs a small partial request, and the first file read downloads the useful part of the version's jar: range requests skip game code and other unwanted files, which are around 70% of the total size. After that, every read, search, and export of that version is served from memory and the cache.

## Documentation

### new MinecraftAssets(options)

All options are optional:

| Option | Default | Description |
|---|---|---|
| `version` | `"release"` | The default version: an id, `"release"`, `"snapshot"`, or `"newest"` |
| `objects` | `false` | Include [asset objects](#asset-objects) in listings and reads by default |
| `cacheDir` | OS temp folder | Where the built-in cache lives (Node.js) |
| `cacheSize` | 1 GB | Cap on the built-in cache in bytes, least recently used purged first. `Infinity` never purges |
| `cacheAPI` | | Use [your own cache](#your-own-cache) in place of the built-in cache |
| `proxy` | | A URL prefix, or a function given the URL and returning the one to request. See [Browser](#browser) |
| `manifest` | | A version manifest to use instead of fetching Mojang's. See [Your own manifest](#your-own-manifest) |
| `manifestExpiry` | response headers | How long in milliseconds to trust a fetched manifest. `Infinity` keeps one copy for the whole session |

### Versions

`assets.manifest` reads Mojang's version manifest. It is fetched on first use, cached, and trusted until its `manifestExpiry`, so quick restarts do not refetch it. The methods below all live on `assets.manifest`:

| Method | Description |
|---|---|
| `.versions(filter?)` | Every version, newest first. See [Filters](#filters) |
| `.version(id)` | One version by id or keyword. Returns `null` when the version is unknown |
| `.latest()` | `{ release, snapshot, newest }` |
| `.details(id)` | The raw per-version JSON. This includes the jar and asset index URLs, JVM arguments, required libraries, and more |
| `.update(manifest?)` | Replace the in-memory manifest, or call with nothing to trigger an early refresh |

```js
const { release, snapshot } = await assets.manifest.latest()
const version = await assets.manifest.version("26.1.2")
```

`assets.version` can be updated at any time. Use `.setVersion(id)` to replace the version used by default for future calls. It returns the [version entry](#version-entries):

```js
await assets.setVersion("snapshot")
assets.version   // "26.3-snapshot-10"
assets.channel   // "snapshot"
```

Both `.version` and `.channel` read from the in-memory manifest, so they start `null` until a call has fetched it.

### Filters

`versions()` takes a type keyword, a function, or an array of either. Arrays are combined, without duplicates. `VersionType` holds the keywords:

```js
import MinecraftAssets, { VersionType } from "minecraft-asset-loader"

await assets.manifest.versions(VersionType.RELEASE)                            // "release"
await assets.manifest.versions([VersionType.SNAPSHOT, VersionType.BETA])       // "snapshot" and "old_beta"
await assets.manifest.versions(all => all.filter(v => v.id.startsWith("26."))) // 2026 releases
```

| Keyword | Matches | Description |
|---|---|---|
| `RELEASE` | `release` | Full releases |
| `SNAPSHOT` | `snapshot` | Snapshots, pre-releases, and release candidates |
| `BETA` | `old_beta` | The beta era, b1.0 to b1.8.1 |
| `ALPHA` | `old_alpha` | The alpha era and everything before it, back to rd-132211 |
| `MAIN` | custom | The newest patch of each minor line (the Nether Update as `1.16.5`, the Copper Age as `1.21.10`). Useful for a version picker of "unique" game versions |
| `MODERN` | custom | Versions with the modern `assets/` layout, 13w24a and later. See [Version entries](#version-entries) |

Your own keywords can be added through standard assignments:

```js
VersionType.RC = all => all.filter(v => v.id.includes("-rc"))
await assets.manifest.versions(VersionType.RC)
```

### Version entries

A version entry contains the data for that version from the manifest, alongside version-scoped versions of the asset methods.

```js
const v = await assets.manifest.version("1.8.9")
await v.getTexture("blocks/stone")
await assets.getTexture("blocks/stone", { version: "1.8.9" })
```

Supported methods are `details`, `list`, `search`, `file`, `read`, every getter, `loadObjects`, and `export`.

`legacyLayout` is a custom property set on versions. It is `true` for versions before 13w24a, where the jar had no `assets/` folder, and all assets sat within the root. The getters (except `.getLang()`) do not work on versions with the legacy asset layout, so use `.read()` instead. `LEGACY_ASSETS_BEFORE` is exported as the timestamp of that cutoff.

### Your own manifest

If you already fetch the manifest yourself, you can pass it in as `manifest` to the constructor. Use `assets.manifest.update(json)` to update it later with a newer version. When a manifest was provided by you, it will not expire and relies on you to keep it refreshed. `.update()` with no argument refetches from Mojang and hands control back to the library.

### Files

| Method | Description |
|---|---|
| `.list(folder?, options?)` | Every file in the version, in a flat list, sorted by path. With a folder, only the files beneath it |
| `.list(folder?, { folders: true })` | `{ files, folders }`, the direct contents of one folder: the files as [file entries](#file-entries), the subfolders as [folder entries](#folder-entries) |
| `.search(query, options?)` | Files matching a query. See [Search](#search) |
| `.file(path, options?)` | One [file entry](#file-entries), or `null` |
| `.read(path, options?)` | The bytes of one file as a `Uint8Array`, or `null` |

All of them take `{ version, objects }`. `read` also takes `prefer`, see [Asset objects](#asset-objects).

```js
await assets.list()                                               // every file, flat
await assets.list("assets/minecraft/textures")                    // every file beneath a folder, flat
await assets.list({ folders: true })                              // browse the root: { files, folders }
await assets.list("assets/minecraft", { folders: true })          // browse a folder
await assets.search("stone", { extension: "png" })                // best matches first
await assets.file("assets/minecraft/textures/block/stone.png")    // one entry, nothing downloaded yet
await assets.read("data/minecraft/loot_table/blocks/stone.json")  // one file's bytes
```

### File entries

Each file is `{ path, source, size, crc, hash }`. The `source` is where it came from: `"jar"` or `"object"`. `crc` is only there on jar files, and `hash` only on [asset objects](#asset-objects). File entries also get `read()` and `raw()` methods:

```js
const stone = await assets.file("assets/minecraft/textures/block/stone.png")
stone.size          // 157
await stone.read()  // the bytes
await stone.raw()   // the bytes as stored: { compression: "deflate-raw" | null, bytes }
```

`raw()` skips decompression, for handing files to a worker or another zip cheaply. `readZip` entries have it too.

### Folder entries

`folder.list()` can be used to list files from this folder instead of from the root. Same formatting as the main list method.

Folder entries are `{ path, source, objects }`, where `path` is the full path from the root, `source` is `"jar"`, `"object"`, or `"both"`, covering every file beneath it, and `objects` is the setting the folder was listed with.

Folders have the `list`, `search`, `file`, and `read` methods for getting files directly from the folder. These automatically use the folder's `objects` setting unless it is manually overridden.

```js
const { folders } = await assets.list("assets/minecraft", { folders: true })
const textures = folders.find(f => f.path.endsWith("/textures"))

await textures.search("stone", { extension: "png" })   // scoped beneath textures/
await textures.read("block/stone.png")
await textures.list()                                  // every file beneath textures/
await textures.list("block")                           // every file beneath textures/block/
await textures.list("block", { folders: true })        // browse textures/block/
```

### Asset objects

Sounds, languages, the panoramas, and a few other files are not stored in the jar. They are served individually from a separate host, by hash, listed in each version's asset index. They are big (around 480 MB combined for a modern version), and cost an extra fetch to list, so they are opt in. Pass `objects: true` to the constructor, or to any call:

```js
const everything = await assets.list({ objects: true })
const harp = await assets.file("assets/minecraft/sounds/note/harp.ogg", { objects: true })
```

With objects on, the listing merges the jar and the objects into one view, each file appearing once. `getSound`, `getLang`, and `loadObjects` never need the flag, they use objects automatically.

Some files exist in both the jar and the objects: the title screen panoramas for example. The object copy is used by default. Pass `prefer: "jar"` to `read` to take the jar copy instead.

`loadObjects` bulk downloads asset objects. It returns a `Map` with file paths as the keys and the downloaded bytes as the values. A failed download is missing from the map rather than thrown.

| Option | Default | Description |
|---|---|---|
| `filter` | | A function given each path, or an array of paths and/or file entries |
| `concurrency` | `32` | How many downloads can run at once |
| `onProgress` | | Called with `(done, total)` as each file finishes |
| `cache` | `true` | Add the downloaded objects to the cache |
| `version` | | Same as everywhere else |

```js
const notes = await assets.loadObjects({ filter: p => p.includes("/sounds/note/"), onProgress: (done, total) => {} })
```

### Search

```js
await assets.search("stone", { extension: "png", limit: 10 })
await assets.search("", { root: "assets/minecraft/models/block" })   // everything under a folder
await assets.search(/panorama_\d/)                                   // a RegExp works too
```

Searching is managed by [path-search-sort](https://github.com/ewanhowell5195/path-search-sort)

| Option | Default | Description |
|---|---|---|
| `root` | | Only paths starting with this prefix, from the top of the tree: `"assets/minecraft/models"` means inside that exact folder |
| `path` | | Only paths passing through these folders, wherever they sit: `"block"` means under any `block/` folder, however deep |
| `extension` | | Only these file types: one extension or several, leading dot optional |
| `filter` | | Your own predicate over the path, only called for what already matched |
| `limit` | | Cap on results, applied after sorting |
| `folders` | `true` | Also match folder names: files inside a matching folder rank after name matches |
| `caseSensitive` | `false` | Case matters, except for the `extension` filter; RegExp queries ignore it |
| `spaces` | `"_"` | What a typed space becomes, e.g. `"_"` for underscore-named files; RegExp queries ignore it |
| `version`, `objects` | | Same as everywhere else |

Results come back sorted into a sensible order, best matches first. See [how it sorts](https://github.com/ewanhowell5195/path-search-sort#how-it-sorts) for the details.

A namespace prefix in the query is stripped, so `minecraft:stone` and `stone` search the same.

### Getters

Getters are shortcuts for the most commonly wanted file types, using identifiers instead of paths. Paths do still work if provided.

`<ns>` in the table below is the id's namespace: `minecraft` by default, or the `namespace` option when given. A prefix on the id overrides both: `getTexture("namespace:id")` reads from `assets/namespace/textures/id`.

| Method | Reads from | Returns |
|---|---|---|
| `.getTexture(id, options?)` | `assets/<ns>/textures/` | The png bytes. With `meta: true`, `{ data, meta }` where `meta` is the parsed `.mcmeta` or `null` |
| `.getModel(id, options?)` | `assets/<ns>/models/` | Parsed json |
| `.getBlockstate(id, options?)` | `assets/<ns>/blockstates/` | Parsed json |
| `.getItemDefinition(id, options?)` | `assets/<ns>/items/` | Parsed json |
| `.getSound(id, options?)` | `assets/<ns>/sounds/` | The ogg bytes |
| `.getStructure(id, options?)` | `data/<ns>/structure/` | The structure nbt bytes. Supports older pack layouts too |
| `.getLang(code, options?)` | `assets/<ns>/lang/` | A key to string object, older `.lang` files included |

Identifiers can be written however you have them: the namespace, the kind folder, and the extension are each optional, and a full path works too:

```js
await assets.getTexture("block/stone")
await assets.getTexture("block/stone.png")
await assets.getModel("minecraft:block/stone")
await assets.getBlockstate("blockstates/stone")
await assets.getSound("minecraft:sounds/note/pling")
await assets.getStructure("igloo/top.nbt")
await assets.getTexture("assets/minecraft/textures/block/stone.png")
```

### Export

Use the `export` function to export all the files to a zip or a folder. Fetches anything that is not already cached. When `dir` is not provided it returns a zip file.

| Option | Default | Description |
|---|---|---|
| `filter` | | A function given each path, or an array of paths and/or file entries |
| `dir` | | Node.js: write a folder tree here instead of returning a zip. Returns the number of files written |
| `objects` | | Include the [asset object](#asset-objects) files too |
| `concurrency` | `32` | How many fetches can run at once |
| `onProgress` | | Called with `(done, total)` as each file finishes |
| `version` | | Same as everywhere else |

```js
const zip = await assets.export({ filter: p => p.includes("note_block") })
const count = await assets.export({ dir: "./out", version: "b1.7.3" })
```

### Caching

Everything Mojang serves except the version manifest is immutable and named by hash, so it is cached forever and never revalidated. On Node.js, the manifest is cached with its expiry. In a browser the browser cache handles this.

| Method | Description |
|---|---|
| `.loadJar(options?)` | Downloads a version's jar data immediately instead of waiting for the first read. `onProgress` is called with `(done, total)` in bytes, for a loading bar |
| `.cacheStats()` | The cache as `{ files, size }` in bytes |
| `.listCache()` | Every cached file as `{ key, size }`, biggest first |
| `.clearCache(key?)` | Clears the full cache, or just one file when passed its key |

```js
await assets.loadJar({ version: "26.1.2", onProgress: (done, total) => {} })

await assets.cacheStats()                 // { files: 212, size: 48213096 }
const [biggest] = await assets.listCache()
await assets.clearCache(biggest.key)
```

### Your own cache

Pass `cacheAPI` to replace the built-in cache with anything that can store bytes:

```js
const assets = new MinecraftAssets({
  cacheAPI: {
    read: key => store.get(key),       // Uint8Array, or undefined
    write: (key, bytes) => store.set(key, bytes),
    delete: key => store.delete(key),  // optional, powers clearCache(key)
    clear: () => store.clear(),        // optional, powers clearCache()
    list: () => Array.from(store, ([key, bytes]) => ({ key, size: bytes.length }))  // optional, powers cacheStats() and listCache()
  }
})
```

Keys are strings starting `meta/` or `blobs/`, and values are always a `Uint8Array`. `cacheStats()` and `listCache()` are `null` when `list()` is not provided.

### Browser

As of the time this was created, the version manifest, version details, and jar hosts all allow cross-origin requests. These can all be fetched directly without the need for a proxy. The asset objects host sends no CORS headers at all, so a CORS proxy server must be used to access them:

```js
const assets = new MinecraftAssets({
  proxy: url => url.includes("resources.download.minecraft.net") ? "https://my-proxy/" + url : false
})
```

A string is used as a prefix on every request. A function can be used for more advanced URLs, or to proxy specific URLs only. Returning `false` requests the original URL directly, without the proxy.

### Module exports

```js
import MinecraftAssets, { VersionType, LEGACY_ASSETS_BEFORE, readZip, writeZip } from "minecraft-asset-loader"
```

| Export | Description |
|---|---|
| `MinecraftAssets` | The class. The default export |
| `VersionType` | The [filter keywords](#filters) |
| `LEGACY_ASSETS_BEFORE` | The 13w24a timestamp, marking which jars use the [legacy layout](#version-entries) |
| `readZip(bytes)` | The library's zip reader. Parses any zip into `{ path, size, crc }` entries with a `read()` method, decompressing nothing until an entry is read |
| `writeZip(files, options?)` | The library's zip writer. Takes a `Map` or plain object of path to bytes, or an array of entries with `read()`, so a `readZip` result or the library's own [file entries](#file-entries) repack directly |

```js
const entries = readZip(bytes)                    // [{ path, size, crc }], each with read()
const icon = await entries.find(e => e.path === "pack.png").read()

const zip = await writeZip({ "pack.mcmeta": mcmetaBytes, "pack.png": iconBytes })
const textures = await writeZip(await assets.list("assets/minecraft/textures/block"))
```

`writeZip` options:

| Option | Default | Description |
|---|---|---|
| `compress` | `true` | `false` stores everything uncompressed, faster for already-compressed files |
| `concurrency` | `32` | How many files can pack at once |
| `onProgress` | | Called with `(done, total)` as each file finishes |

## License

[MPL-2.0](LICENSE) © [Ewan Howell](https://ewanhowell.com/)
