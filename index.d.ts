export type VersionTypeName = "release" | "snapshot" | "old_beta" | "old_alpha"

/** A raw row of Mojang's version manifest. */
export interface ManifestRow {
  id: string
  type: VersionTypeName | string
  url: string
  time?: string
  releaseTime: string
  sha1?: string
  complianceLevel?: number
  [key: string]: unknown
}

export interface VersionManifest {
  latest?: { release?: string, snapshot?: string }
  versions: ManifestRow[]
}

export type VersionFilter = string | ((all: ManifestVersion[]) => ManifestVersion[])
export type VersionFilterArg = VersionFilter | VersionFilter[]

export interface VersionTypeKeywords {
  RELEASE: "release"
  SNAPSHOT: "snapshot"
  BETA: "old_beta"
  ALPHA: "old_alpha"
  /** One entry per advertised update: the newest patch of each line, curated drops, and a newer snapshot. */
  MAIN: (all: ManifestVersion[]) => ManifestVersion[]
  /** Versions with the modern assets/ layout: 13w24a and later. */
  MODERN: (all: ManifestVersion[]) => ManifestVersion[]
  /** User keywords are plain assignments. */
  [keyword: string]: VersionFilter
}

export const VersionType: VersionTypeKeywords

/** The 13w24a instant: before it jars have no assets/ folder. */
export const LEGACY_ASSETS_BEFORE: number

/** An entry read from a zip: plain data plus a memoised read(). */
export interface ZipEntry {
  path: string
  size: number
  /** CRC-32 of the uncompressed bytes, from the zip's central directory. */
  crc: number
  read(): Promise<Uint8Array>
  /** The bytes as stored, skipping decompression. */
  raw(): Promise<RawBytes>
}

/** Parses zip bytes into entries. Nothing is decompressed until an entry is read. */
export function readZip(bytes: Uint8Array | ArrayBuffer): ZipEntry[]

/** Builds a zip from a Map or plain object of path to bytes, or an array of entries with read(). */
export function writeZip(
  files: Map<string, Uint8Array> | Record<string, Uint8Array> | Array<{ path: string, read(): Uint8Array | Promise<Uint8Array> }>,
  options?: {
    /** false stores everything uncompressed, faster for already-compressed files. Default true. */
    compress?: boolean
    /** How many files pack at once. Default 32. */
    concurrency?: number
    onProgress?: (done: number, total: number) => void
  }
): Promise<Uint8Array>

/** The latest release, the newest snapshot, or whichever of the two is newer. */
export type VersionKeyword = "release" | "snapshot" | "newest"

/** A version to operate on: an id, a keyword, or an entry from the manifest. */
export type VersionRef = string | VersionKeyword | ManifestVersion

export interface VersionOptions {
  version?: VersionRef
}

export interface ObjectsOptions extends VersionOptions {
  /** Include asset objects (the separate host) in listings and reads. */
  objects?: boolean
}

export interface ReadOptions extends ObjectsOptions {
  /** On paths present in both the jar and the objects, take the jar copy. */
  prefer?: "jar" | "object"
}

/** The query and every option apart from `version` and `objects` are path-search-sort's. */
export interface SearchOptions extends ObjectsOptions {
  /** Only paths starting with this prefix. */
  root?: string
  /** Only paths passing through these folders, wherever they sit. */
  path?: string
  /** One or several extensions, leading dot optional. */
  extension?: string | string[]
  /** Your own predicate over the path, only called for what already matched. */
  filter?: (path: string) => boolean
  /** Cap on results, applied after sorting. */
  limit?: number
  /** Also match folder names, on by default; files inside a matching folder rank after name matches. */
  folders?: boolean
  caseSensitive?: boolean
  /** What a typed space becomes. Default "_". */
  spaces?: string
}

/** A file's bytes as stored: plain when compression is null, deflated when "deflate-raw". */
export interface RawBytes {
  compression: "deflate-raw" | null
  bytes: Uint8Array
}

export interface FileEntry {
  path: string
  /** Which copy a plain read takes. Java only: bedrock and assets have a single source, so it is absent there. */
  source?: "jar" | "object"
  size: number
  /** Present when an asset object backs the entry. */
  hash?: string
  /** CRC-32 of the uncompressed bytes, present on jar-backed entries. */
  crc?: number
  /** The bytes, memoised: repeat reads return the identical buffer. */
  read(options?: { prefer?: "jar" | "object" }): Promise<Uint8Array>
  /** The bytes as stored, skipping decompression. */
  raw(options?: { prefer?: "jar" | "object" }): Promise<RawBytes>
}

export interface FolderEntry {
  /** Full path, ready to feed back into list(). */
  path: string
  /** Everything beneath: jar, object, or both. Java only, absent on bedrock and assets. */
  source?: "jar" | "object" | "both"
  /** The objects setting the folder was listed with, used by its methods unless overridden. */
  objects: boolean
  list(folder?: string | FolderEntry, options?: { objects?: boolean, folders?: false }): Promise<FileEntry[]>
  list(folder: string | FolderEntry, options: { objects?: boolean, folders: true }): Promise<FolderListing>
  list(options: { objects?: boolean, folders: true }): Promise<FolderListing>
  list(options: { objects?: boolean, folders?: false }): Promise<FileEntry[]>
  search(query: string | RegExp, options?: Omit<SearchOptions, "version" | "root">): Promise<FileEntry[]>
  file(relativeOrFullPath: string): Promise<FileEntry | null>
  read(relativeOrFullPathOrEntry: string | FileEntry, options?: { prefer?: "jar" | "object" }): Promise<Uint8Array | null>
}

export interface FolderListing {
  files: FileEntry[]
  folders: FolderEntry[]
}

export interface GetterOptions extends VersionOptions {
  /** The default namespace when the id carries no prefix. Default "minecraft". Bedrock has no namespaces, so anything but "minecraft" is a miss there. */
  namespace?: string
}

export interface TextureOptions extends GetterOptions {
  /** Return `{ data, meta }` with the parsed .mcmeta (or null) alongside the png. */
  meta?: boolean
  prefer?: "jar" | "object"
}

export interface TextureWithMeta {
  data: Uint8Array
  meta: Record<string, unknown> | null
}

export type BulkFilter = ((path: string) => boolean) | Array<string | FileEntry>

export interface LoadObjectsOptions extends VersionOptions {
  filter?: BulkFilter
  /** Default 32. */
  concurrency?: number
  onProgress?: (done: number, total: number) => void
  /** `false` skips the cache entirely: retrieval without warming. */
  cache?: boolean
}

export interface ExportOptions extends ObjectsOptions {
  filter?: BulkFilter
  /** Node only: write a folder tree here instead of returning zip bytes. */
  dir?: string
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}

/** The raw per-version document (downloads, assetIndex, libraries, ...). */
export interface VersionDetails {
  id: string
  assets?: string
  assetIndex?: { id: string, sha1: string, size: number, totalSize?: number, url: string }
  downloads: { client: { sha1: string, size: number, url: string }, [key: string]: { sha1: string, size: number, url: string } }
  [key: string]: unknown
}

/** A manifest row enriched with `legacyLayout` and every version-scoped call bound to it. */
export interface ManifestVersion extends ManifestRow {
  /** True before 13w24a, when textures sit at the jar root and identifier getters cannot resolve. */
  legacyLayout: boolean
  details(): Promise<VersionDetails>
  list(folder?: string | FolderEntry, options?: Omit<ObjectsOptions, "version"> & { folders?: false }): Promise<FileEntry[]>
  list(folder: string | FolderEntry, options: Omit<ObjectsOptions, "version"> & { folders: true }): Promise<FolderListing>
  list(options: Omit<ObjectsOptions, "version"> & { folders: true }): Promise<FolderListing>
  list(options: Omit<ObjectsOptions, "version"> & { folders?: false }): Promise<FileEntry[]>
  search(query: string | RegExp, options?: Omit<SearchOptions, "version">): Promise<FileEntry[]>
  file(path: string, options?: Omit<ObjectsOptions, "version">): Promise<FileEntry | null>
  read(pathOrEntry: string | FileEntry, options?: Omit<ReadOptions, "version">): Promise<Uint8Array | null>
  getTexture(id: string, options?: Omit<TextureOptions, "version"> & { meta?: false }): Promise<Uint8Array | null>
  getTexture(id: string, options: Omit<TextureOptions, "version"> & { meta: true }): Promise<TextureWithMeta | null>
  getModel(id: string, options?: Omit<GetterOptions, "version">): Promise<any | null>
  getBlockstate(id: string, options?: Omit<GetterOptions, "version">): Promise<any | null>
  getItemDefinition(id: string, options?: Omit<GetterOptions, "version">): Promise<any | null>
  getSound(id: string, options?: Omit<GetterOptions, "version">): Promise<Uint8Array | null>
  getStructure(id: string, options?: Omit<GetterOptions, "version">): Promise<Uint8Array | null>
  getLang(code: string, options?: Omit<GetterOptions, "version">): Promise<Record<string, string> | null>
  loadJar(options?: { onProgress?: (done: number, total: number | null) => void }): Promise<void>
  loadObjects(options?: Omit<LoadObjectsOptions, "version">): Promise<Map<string, Uint8Array>>
  export(options?: Omit<ExportOptions, "version"> & { dir?: undefined }): Promise<Uint8Array>
  export(options: Omit<ExportOptions, "version"> & { dir: string }): Promise<number>
}

export interface Latest {
  release: ManifestVersion | null
  /** The newest genuinely snapshot-typed entry, never the manifest's own `latest` field. */
  snapshot: ManifestVersion | null
  /** The head of the list. */
  newest: ManifestVersion | null
}

export interface ManifestAPI {
  versions(filter?: VersionFilterArg): Promise<ManifestVersion[]>
  version(id: string | VersionKeyword): Promise<ManifestVersion | null>
  latest(): Promise<Latest>
  details(version: VersionRef): Promise<VersionDetails>
  /** Supply a manifest to own, or call with nothing to refetch now and hand ownership back. */
  update(manifest?: VersionManifest): Promise<void>
}

/** Caller-supplied storage. Keys are `meta/...` or `blobs/...`; values are always bytes. */
export interface CacheAPI {
  read?(key: string): Uint8Array | ArrayBuffer | null | undefined | Promise<Uint8Array | ArrayBuffer | null | undefined>
  write?(key: string, bytes: Uint8Array): void | Promise<void>
  delete?(key: string): void | Promise<void>
  /** Every stored file with its size, powering cacheStats() and listCache(). */
  list?(): Array<{ key: string, size: number }> | Promise<Array<{ key: string, size: number }>>
  clear?(): void | Promise<void>
}

export interface MinecraftAssetsOptions {
  /** What to serve: "java" (default) from Mojang's version servers, "assets" for the Java asset indexes on their own (no jar), or "bedrock" from the bedrock-samples releases. */
  type?: "java" | "assets" | "bedrock"
  /** Where the built-in cache lives (Node). Default: an OS temp location. */
  cacheDir?: string
  /** Byte cap on the built-in cache, LRU. Default 1 GB; `Infinity` or `null` disables eviction. */
  cacheSize?: number | null
  /** Namespaces the built-in cache, so separate instances can keep separate caches. */
  cacheKey?: string
  /** Replaces the built-in cache entirely. */
  cacheAPI?: CacheAPI
  /** A url prefix, or a function returning the url to request (falsy means direct). */
  proxy?: string | ((url: string) => string | false | null | undefined)
  /** The default version. Default: "release". */
  version?: VersionRef | null
  /** A caller-supplied manifest, owned by the caller. */
  manifest?: VersionManifest
  /** Trust window in ms for a library-fetched manifest; `Infinity`/`null` keeps one copy per session. */
  manifestExpiry?: number | null
  /** Instance-wide default for the objects flag. Default false. */
  objects?: boolean
  /**
   * Probe the local .minecraft installation for jars, asset indexes, and asset objects before
   * downloading (Node only, "java" and "assets" types). On by default at the platform's standard
   * location; a string sets the folder, `false` disables. Files are sha1-verified against the
   * manifest before use, and anything missing or failing falls back to the normal download.
   */
  minecraft?: string | boolean
}

export default class MinecraftAssets {
  constructor(options?: MinecraftAssetsOptions)

  /** The id the default version resolves to, or null before the manifest has been loaded. */
  readonly version: string | null
  /** The default version's type, or null before the manifest has been loaded. */
  readonly channel: VersionTypeName | null
  /**
   * Changes the default version: an id, a keyword, or an entry. Resolves it (fetching the manifest if
   * needed) and returns the entry; an unknown version throws, changing nothing.
   */
  setVersion(value?: VersionRef | null): Promise<ManifestVersion>
  readonly manifest: ManifestAPI

  list(folder?: string | FolderEntry, options?: ObjectsOptions & { folders?: false }): Promise<FileEntry[]>
  list(folder: string | FolderEntry, options: ObjectsOptions & { folders: true }): Promise<FolderListing>
  list(options: ObjectsOptions & { folders: true }): Promise<FolderListing>
  list(options: ObjectsOptions & { folders?: false }): Promise<FileEntry[]>
  search(query: string | RegExp, options?: SearchOptions): Promise<FileEntry[]>
  file(path: string, options?: ObjectsOptions): Promise<FileEntry | null>
  read(pathOrEntry: string | FileEntry, options?: ReadOptions): Promise<Uint8Array | null>

  getTexture(id: string, options?: TextureOptions & { meta?: false }): Promise<Uint8Array | null>
  getTexture(id: string, options: TextureOptions & { meta: true }): Promise<TextureWithMeta | null>
  getModel(id: string, options?: GetterOptions): Promise<any | null>
  getBlockstate(id: string, options?: GetterOptions): Promise<any | null>
  getItemDefinition(id: string, options?: GetterOptions): Promise<any | null>
  getSound(id: string, options?: GetterOptions): Promise<Uint8Array | null>
  getStructure(id: string, options?: GetterOptions): Promise<Uint8Array | null>
  getLang(code: string, options?: GetterOptions): Promise<Record<string, string> | null>

  /** Downloads the version's data now, with byte progress, instead of waiting for the first read. total is null when the server declares no length. */
  loadJar(options?: VersionOptions & { onProgress?: (done: number, total: number | null) => void }): Promise<void>
  loadObjects(options?: LoadObjectsOptions): Promise<Map<string, Uint8Array>>
  export(options?: ExportOptions & { dir?: undefined }): Promise<Uint8Array>
  export(options: ExportOptions & { dir: string }): Promise<number>

  /** File count and total bytes of the cache. null when a cacheAPI has no list(). */
  cacheStats(): Promise<{ files: number, size: number } | null>
  /** Every cached file as { key, size }, biggest first. null when a cacheAPI has no list(). */
  listCache(): Promise<Array<{ key: string, size: number }> | null>
  /** Clears the whole cache, or just one file when passed its key. */
  clearCache(key?: string): Promise<void>
  /** Changes the byte cap on the built-in cache and evicts down to it. `Infinity` or `null` disables eviction. Does nothing with a cacheAPI. */
  setCacheSize(size: number | null): Promise<void>
}
