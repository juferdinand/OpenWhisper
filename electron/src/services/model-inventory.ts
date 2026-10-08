import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, opendir, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { detectModelFamily, parseModelCatalog, type Catalog, type CatalogModel } from "../core/model-catalog.js";
import { prepareHostProfile, type HostProfile } from "./host-profile.js";

export const MAX_MODEL_BYTES = 4_000_000_000;
export const MAX_INVENTORY_MODELS = 128;
export const MODEL_COPY_BYTES = 64 * 1024;
const basenameSchema = z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 255 &&
  value !== "." && value !== ".." && !/[\/\\\u0000-\u001f\u007f-\u009f]/u.test(value));
const idSchema = z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 1024 &&
  value !== "." && value !== ".." && !/[\/\\\u0000-\u001f\u007f-\u009f]/u.test(value));
const sourceSchema = z.string().min(1).refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes("\0"));
const selectionSchema = z.strictObject({ gpu: z.boolean() });
const receiptBrand = Symbol("owned model publication receipt");
/** Host-only opaque operation capability. JSON/IPC copies cannot recreate it. */
export interface ModelPublicationReceipt { readonly [receiptBrand]: true }
const expectedSchema = z.strictObject({ bytes: z.number().int().min(1).max(MAX_MODEL_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();
const receiptSchema = z.custom<ModelPublicationReceipt>((value) => typeof value === "object" && value !== null && publicationReceipts.has(value));
const importSchema = z.strictObject({ replace: z.boolean().default(false), signal: z.instanceof(AbortSignal).optional(),
  expected: expectedSchema.optional(), receipt: receiptSchema.optional() });

export type ModelInventoryFailure = "INVALID_PROFILE" | "INVALID_CATALOG" | "INVALID_ID" | "INVALID_SOURCE" |
  "UNSAFE_DIRECTORY" | "UNSAFE_FILE" | "NOT_INSTALLED" | "MODEL_CHANGED" | "SOURCE_CHANGED" |
  "LEASED" | "RELEASE_FAILED" | "EXISTS" | "BUSY" | "CAPACITY" | "CANCELLED" | "STORAGE_FAILED" | "COMMITTED_UNCERTAIN" |
  "INTEGRITY_FAILED" | "INVALID_RECEIPT";
export class ModelInventoryError extends Error {
  constructor(readonly code: ModelInventoryFailure, readonly receipt?: ModelPublicationReceipt) { super(code); this.name = "ModelInventoryError"; }
}
export interface ModelFileIdentity {
  readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint;
}
export interface InstalledModel {
  readonly model: CatalogModel; readonly bytes: number; readonly identity: ModelFileIdentity;
  /** Owned complete bytes are not proof of publisher authenticity or valid native weights. */
  readonly verification: "private-file" | "legacy-owned-file";
}
export interface ImportedModel extends InstalledModel { readonly copiedSha256: string }
export interface ModelLease {
  readonly id: string;
  readonly model: Readonly<{ path: string; family: "whisper" | "parakeet"; gpu: boolean }>;
  readonly identity: ModelFileIdentity;
  validate(): Promise<void>;
  /** Host-only: pass actual native-owner reap completion. A rejection retains the lease. */
  release(reaped: Promise<void>): Promise<void>;
}
export interface ModelInventoryIO {
  read(file: FileHandle, buffer: Buffer, position: number): Promise<number>;
  write(file: FileHandle, bytes: Buffer): Promise<void>;
  syncFile(file: FileHandle): Promise<void>;
  syncDirectory(file: FileHandle): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
interface DirectoryIdentity { readonly dev: bigint; readonly ino: bigint }
interface ImportOwner { readonly token: symbol; readonly file: string; readonly model: CatalogModel }
interface Publication {
  readonly kind: "import"; readonly model: CatalogModel; readonly identity: ModelFileIdentity;
  readonly temporary: string; readonly copiedSha256: string; needsUnlink: boolean; readyIdentity?: ModelFileIdentity;
  readonly receipt?: ModelPublicationReceipt;
  directoryClosing?: Promise<void>;
}
interface Deletion { readonly kind: "remove"; readonly model: CatalogModel }
interface InventoryState {
  readonly parent: DirectoryIdentity; readonly catalogSignature: string;
  readonly legacyModels: boolean;
  queue: Promise<void>; readonly leases: Map<string, Set<symbol>>;
  readonly pending: Map<string, Publication | Deletion>; importing: ImportOwner | undefined;
}
interface ReceiptState {
  readonly inventory: InventoryState; readonly model: CatalogModel; readonly receipt: ModelPublicationReceipt;
  used: boolean; publication?: Publication; committed?: ImportedModel;
  cleanup?: () => Promise<void>; cleanupComplete: boolean;
}
const publicationReceipts = new WeakMap<object, ReceiptState>();
// Cooperating instances in this host process share mutation/lease ownership. This
// is not an interprocess lock or a sandbox against another process with this UID.
const inventories = new Map<string, InventoryState>();
const sameInode = (left: DirectoryIdentity, right: DirectoryIdentity): boolean => left.dev === right.dev && left.ino === right.ino;
const sameFile = (left: ModelFileIdentity, right: ModelFileIdentity): boolean => sameInode(left, right) &&
  left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const identity = (stats: BigIntStats): ModelFileIdentity => Object.freeze({ dev: stats.dev, ino: stats.ino,
  size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs });
const errorCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;
function active(signal?: AbortSignal): void { if (signal?.aborted) throw new ModelInventoryError("CANCELLED"); }
function ownedFile(stats: BigIntStats, empty = false, legacyModels = false): boolean {
  const mode = stats.mode & 0o7777n;
  return stats.isFile() && stats.uid === BigInt(process.getuid?.() ?? -1) && stats.nlink === 1n &&
    (legacyModels ? (mode & 0o7022n) === 0n && (mode & 0o400n) !== 0n : mode === 0o600n) &&
    stats.size >= (empty ? 0n : 1n) && stats.size <= BigInt(MAX_MODEL_BYTES);
}
function directoryMode(mode: bigint, legacyModels: boolean): boolean {
  return legacyModels ? (mode & 0o7022n) === 0n && (mode & 0o500n) === 0o500n : mode === 0o700n;
}
async function directoryIdentity(path: string, expected?: DirectoryIdentity, legacyModels = false): Promise<DirectoryIdentity> {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new ModelInventoryError("UNSAFE_DIRECTORY");
  const ancestors: string[] = [];
  for (let cursor = path;; cursor = dirname(cursor)) { ancestors.push(cursor); if (dirname(cursor) === cursor) break; }
  let found: DirectoryIdentity | undefined;
  try {
    for (const ancestor of ancestors.reverse()) {
      const stats = await lstat(ancestor, { bigint: true }), mode = stats.mode & 0o7777n;
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error();
      if (ancestor === path) {
        if (stats.uid !== BigInt(uid) || !directoryMode(mode, legacyModels) || (expected && !sameInode(stats, expected))) throw new Error();
        found = { dev: stats.dev, ino: stats.ino };
      } else if ((stats.uid !== BigInt(uid) && stats.uid !== 0n) ||
          ((mode & 0o022n) !== 0n && !(stats.uid === 0n && (mode & 0o1000n) !== 0n))) throw new Error();
    }
  } catch { throw new ModelInventoryError("UNSAFE_DIRECTORY"); }
  if (!found) throw new ModelInventoryError("UNSAFE_DIRECTORY"); return found;
}
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) { const written = await file.write(bytes, offset, bytes.length - offset, null);
    if (!written.bytesWritten) throw new ModelInventoryError("STORAGE_FAILED"); offset += written.bytesWritten; }
}
/** Receipt owners retain this promise before invoking close, including a
 * synchronous refusal. A retry must not manufacture a new close certificate. */
const receiptClose = (file: FileHandle): Promise<void> => Promise.resolve().then(() => file.close());

/** Resolved host profile only. No networking, renderer-selected target or native helper calls. */
export class ModelInventory {
  readonly catalog: Catalog;
  private get leases() { return this.state.leases; }
  private get pending() { return this.state.pending; }
  private get importing() { return this.state.importing; }
  private set importing(owner: ImportOwner | undefined) { this.state.importing = owner; }
  private constructor(catalog: Catalog, private readonly directory: string, private readonly parent: DirectoryIdentity,
                      private readonly io: ModelInventoryIO, private readonly state: InventoryState,
                      private readonly legacyModels: boolean) { this.catalog = catalog; }

  static async open(profile: HostProfile, input: unknown, effects: Partial<ModelInventoryIO> = {}): Promise<ModelInventory> {
    let catalog: Catalog;
    try {
      catalog = parseModelCatalog(input);
      if (new Set(catalog.models.map((model) => model.file)).size !== catalog.models.length ||
          catalog.models.some((model) => !basenameSchema.safeParse(model.file).success)) throw new Error();
    } catch { throw new ModelInventoryError("INVALID_CATALOG"); }
    try { prepareHostProfile(profile); } catch { throw new ModelInventoryError("INVALID_PROFILE"); }
    // Legacy models stay in place with their original safe modes; Dev and new import files remain private.
    const legacyModels = profile.appId === "io.github.whisperfree";
    const parent = await directoryIdentity(profile.paths.models, undefined, legacyModels);
    const catalogSignature = JSON.stringify(catalog); let state = inventories.get(profile.paths.models);
    if (state && !sameInode(state.parent, parent)) {
      if (state.importing || state.pending.size || [...state.leases.values()].some((held) => held.size)) throw new ModelInventoryError("UNSAFE_DIRECTORY");
      state = undefined;
    }
    if (state && state.catalogSignature !== catalogSignature) throw new ModelInventoryError("INVALID_CATALOG");
    if (state && state.legacyModels !== legacyModels) throw new ModelInventoryError("INVALID_PROFILE");
    state ??= { parent, catalogSignature, legacyModels, queue: Promise.resolve(), leases: new Map(), pending: new Map(), importing: undefined };
    inventories.set(profile.paths.models, state);
    return new ModelInventory(catalog, profile.paths.models, parent, {
      read: effects.read ?? (async (file, bytes, position) => (await file.read(bytes, 0, bytes.length, position)).bytesRead),
      write: effects.write ?? writeAll, syncFile: effects.syncFile ?? ((file) => file.sync()),
      syncDirectory: effects.syncDirectory ?? ((file) => file.sync()), link: effects.link ?? link,
      rename: effects.rename ?? rename, unlink: effects.unlink ?? unlink,
    }, state, legacyModels);
  }
  private checkDirectory(): Promise<DirectoryIdentity> { return directoryIdentity(this.directory, this.parent, this.legacyModels); }
  private run<T>(effect: () => Promise<T>): Promise<T> {
    const result = this.state.queue.then(effect).catch((error: unknown) => {
      if (error instanceof ModelInventoryError) throw error; throw new ModelInventoryError("STORAGE_FAILED");
    });
    this.state.queue = result.then(() => {}, () => {}); return result;
  }
  private checkedId(input: unknown): string {
    const id = idSchema.safeParse(input); if (!id.success) throw new ModelInventoryError("INVALID_ID"); return id.data;
  }
  private fromFile(file: string): CatalogModel {
    if (!basenameSchema.safeParse(file).success) throw new ModelInventoryError("INVALID_ID");
    const catalog = this.catalog.models.find((model) => model.file === file); if (catalog) return catalog;
    if (!file.endsWith(".bin")) throw new ModelInventoryError("INVALID_ID");
    const id = this.checkedId(file.slice(0, -4));
    if (this.catalog.models.some((model) => model.id === id)) throw new ModelInventoryError("INVALID_ID");
    return Object.freeze({ id, file, family: detectModelFamily(file), title: id, repository: "", size: "", note: "Imported" });
  }
  private fromId(input: unknown): CatalogModel {
    const id = this.checkedId(input), catalog = this.catalog.models.find((model) => model.id === id);
    if (catalog) return catalog;
    const custom = this.fromFile(`${id}.bin`);
    if (custom.id !== id) throw new ModelInventoryError("INVALID_ID"); return custom;
  }
  private async directoryFile(): Promise<FileHandle> {
    await this.checkDirectory();
    const file = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stats = await file.stat({ bigint: true });
      if (!stats.isDirectory() || !sameInode(stats, this.parent) || stats.uid !== BigInt(process.getuid?.() ?? -1) ||
          !directoryMode(stats.mode & 0o7777n, this.legacyModels)) throw new ModelInventoryError("UNSAFE_DIRECTORY"); return file;
    } catch (error: unknown) { await file.close(); throw error; }
  }
  private async file(model: CatalogModel, privateOnly = false): Promise<InstalledModel> {
    await this.checkDirectory();
    let file: FileHandle;
    try { file = await open(join(this.directory, model.file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: unknown) { throw new ModelInventoryError(errorCode(error, "ENOENT") ? "NOT_INSTALLED" : "UNSAFE_FILE"); }
    try {
      const stats = await file.stat({ bigint: true }); await this.checkDirectory();
      const named = await lstat(join(this.directory, model.file), { bigint: true });
      if (!ownedFile(stats, false, this.legacyModels && !privateOnly) || !ownedFile(named, false, this.legacyModels && !privateOnly) ||
          !sameFile(identity(stats), identity(named))) throw new ModelInventoryError("UNSAFE_FILE");
      return Object.freeze({ model, identity: identity(stats), bytes: Number(stats.size),
        verification: (stats.mode & 0o7777n) === 0o600n ? "private-file" : "legacy-owned-file" });
    } finally { await file.close(); }
  }
  private capacity(installed: readonly InstalledModel[]): number {
    const custom = new Set(installed.filter((item) => !this.catalog.models.some((model) => model.id === item.model.id))
      .map((item) => item.model.id));
    // An uncertain published model still reserves its inventory slot while it
    // is unavailable. A completed unlink does not reserve a deleted slot.
    for (const [id, pending] of this.pending) {
      if (pending.kind === "import" && !this.catalog.models.some((model) => model.id === id)) custom.add(id);
    }
    return this.catalog.models.length + custom.size;
  }
  private async scan(): Promise<InstalledModel[]> {
    await this.checkDirectory();
    const directory = await opendir(this.directory), found: InstalledModel[] = [];
    let count = 0;
    for await (const entry of directory) {
      if (++count > 4096) throw new ModelInventoryError("CAPACITY");
      if (!entry.name.endsWith(".bin")) continue;
      let model: CatalogModel;
      try { model = this.fromFile(entry.name); } catch { continue; }
      if (this.pending.has(model.id)) continue;
      try { found.push(await this.file(model)); }
      catch (error: unknown) {
        if (!(error instanceof ModelInventoryError && ["UNSAFE_FILE", "NOT_INSTALLED"].includes(error.code))) throw error;
      }
    }
    if (this.capacity(found) > MAX_INVENTORY_MODELS) {
      throw new ModelInventoryError("CAPACITY");
    }
    await this.checkDirectory();
    return found.sort((a, b) => a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0);
  }
  installed(): Promise<readonly InstalledModel[]> { return this.run(async () => Object.freeze(await this.scan())); }
  acquire(input: unknown, choice: unknown): Promise<ModelLease> {
    return this.run(async () => {
      const model = this.fromId(input), selected = selectionSchema.safeParse(choice);
      if (!selected.success) throw new ModelInventoryError("INVALID_ID");
      if (this.pending.has(model.id)) throw new ModelInventoryError("COMMITTED_UNCERTAIN");
      const installed = await this.file(model), token = Symbol("owned model lease");
      const tokens = this.leases.get(model.file) ?? new Set<symbol>(); tokens.add(token); this.leases.set(model.file, tokens);
      let released = false, releasing: Promise<void> | undefined;
      const release = (reaped: Promise<void>): Promise<void> => {
        if (released) return Promise.resolve(reaped).then(() => {}, () => { throw new ModelInventoryError("RELEASE_FAILED"); });
        if (releasing) return Promise.all([reaped, releasing]).then(() => {}, () => { throw new ModelInventoryError("RELEASE_FAILED"); });
        releasing = Promise.resolve(reaped).then(() => this.run(async () => {
          tokens.delete(token); if (!tokens.size) this.leases.delete(model.file); released = true;
        })).catch(() => { releasing = undefined; throw new ModelInventoryError("RELEASE_FAILED"); });
        return releasing;
      };
      return Object.freeze({ id: model.id, model: Object.freeze({ path: join(this.directory, model.file), family: model.family, gpu: selected.data.gpu }),
        identity: installed.identity, release, validate: () => this.run(async () => {
          if (released) throw new ModelInventoryError("MODEL_CHANGED");
          let current: InstalledModel;
          try { current = await this.file(model); } catch (error: unknown) {
            if (error instanceof ModelInventoryError && error.code === "UNSAFE_DIRECTORY") throw error;
            throw new ModelInventoryError("MODEL_CHANGED");
          }
          if (!sameFile(current.identity, installed.identity)) throw new ModelInventoryError("MODEL_CHANGED");
        }) });
    });
  }
  private held(model: CatalogModel): void { if (this.leases.get(model.file)?.size) throw new ModelInventoryError("LEASED"); }
  private async removePart(path: string, expected: ModelFileIdentity): Promise<void> {
    await this.checkDirectory();
    let stats: BigIntStats;
    try { stats = await lstat(path, { bigint: true }); } catch (error: unknown) { if (errorCode(error, "ENOENT")) return; throw error; }
    if (!stats.isFile() || !sameInode(stats, expected) || stats.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stats.mode & 0o7777n) !== 0o600n) throw new ModelInventoryError("MODEL_CHANGED");
    await this.io.unlink(path);
  }
  /** The genuine host profile, not a copied/renderer-supplied path object. */
  belongsToProfile(profile: HostProfile): boolean {
    try { prepareHostProfile(profile); return profile.paths.models === this.directory && (profile.appId === "io.github.whisperfree") === this.legacyModels; }
    catch { return false; }
  }
  createPublicationReceipt(input: unknown): ModelPublicationReceipt {
    const model = this.fromId(input), receipt: ModelPublicationReceipt = Object.freeze({ [receiptBrand]: true as const });
    publicationReceipts.set(receipt, { inventory: this.state, model, receipt, used: false, cleanupComplete: false });
    return receipt;
  }
  private receipt(input: unknown): ReceiptState {
    if (typeof input !== "object" || input === null) throw new ModelInventoryError("INVALID_RECEIPT");
    const record = publicationReceipts.get(input);
    if (!record || record.inventory !== this.state) throw new ModelInventoryError("INVALID_RECEIPT"); return record;
  }
  ensurePublicationCommitted(input: unknown): Promise<ImportedModel> {
    return this.run(async () => {
      const record = this.receipt(input);
      if (!record.used || !record.publication) throw new ModelInventoryError("INVALID_RECEIPT");
      if (record.committed) {
        const current = await this.file(record.model, true);
        if (!sameFile(current.identity, record.committed.identity)) throw new ModelInventoryError("MODEL_CHANGED"); return record.committed;
      }
      if (this.pending.get(record.model.id) !== record.publication) throw new ModelInventoryError("INVALID_RECEIPT");
      const result = await this.finish(record.model.id);
      if (!result) throw new ModelInventoryError("INVALID_RECEIPT"); return result;
    });
  }
  /** Retry only this import's captured cleanup after the original operation has
   * settled. The same descriptor-close promises are retained, never reissued. */
  async finishImportCleanup(input: unknown): Promise<void> {
    const record = this.receipt(input);
    if (!record.used) return;
    if (record.cleanupComplete) return;
    if (!record.cleanup) throw new ModelInventoryError("BUSY");
    await record.cleanup();
  }
  private async finish(id: string): Promise<ImportedModel | null> {
    const pending = this.pending.get(id); if (!pending) throw new ModelInventoryError("INVALID_ID");
    if (pending.kind === "import" && pending.receipt && pending.directoryClosing) {
      try { await pending.directoryClosing; delete pending.directoryClosing; }
      catch { throw new ModelInventoryError("COMMITTED_UNCERTAIN", pending.receipt); }
    }
    const directory = await this.directoryFile();
    let closed = false;
    const closeDirectory = (): Promise<void> => pending.kind === "import" && pending.receipt ?
      pending.directoryClosing ??= receiptClose(directory) : directory.close();
    try {
      if (pending.kind === "remove") {
        try { await lstat(join(this.directory, pending.model.file)); throw new ModelInventoryError("MODEL_CHANGED"); }
        catch (error: unknown) { if (!errorCode(error, "ENOENT")) throw error; }
        await this.io.syncDirectory(directory); await this.checkDirectory();
        try { await lstat(join(this.directory, pending.model.file)); throw new ModelInventoryError("MODEL_CHANGED"); }
        catch (error: unknown) { if (!errorCode(error, "ENOENT")) throw error; }
        await directory.close(); closed = true;
        this.pending.delete(id); return null;
      }
      const named = await lstat(join(this.directory, pending.model.file), { bigint: true });
      if (!sameInode(named, pending.identity) || named.size !== pending.identity.size || named.mtimeNs !== pending.identity.mtimeNs) {
        throw new ModelInventoryError("MODEL_CHANGED");
      }
      if (pending.needsUnlink) { await this.removePart(pending.temporary, pending.identity); pending.needsUnlink = false; }
      const installed = await this.file(pending.model, true);
      if (!sameInode(installed.identity, pending.identity) ||
          (pending.readyIdentity && !sameFile(installed.identity, pending.readyIdentity))) throw new ModelInventoryError("MODEL_CHANGED");
      pending.readyIdentity = installed.identity;
      await this.io.syncDirectory(directory); await this.checkDirectory();
      const confirmed = await this.file(pending.model, true);
      if (!sameFile(confirmed.identity, installed.identity)) throw new ModelInventoryError("MODEL_CHANGED");
      await closeDirectory(); closed = true;
      const result = Object.freeze({ ...confirmed, copiedSha256: pending.copiedSha256 });
      if (pending.receipt) this.receipt(pending.receipt).committed = result;
      this.pending.delete(id); return result;
    } catch { throw new ModelInventoryError("COMMITTED_UNCERTAIN", pending.kind === "import" ? pending.receipt : undefined); }
    finally { if (!closed) { try { await closeDirectory(); } catch { /* The retained publication remains unavailable. */ } } }
  }
  ensureCommitted(input: unknown): Promise<ImportedModel | null> { return this.run(() => this.finish(this.checkedId(input))); }
  remove(input: unknown): Promise<void> {
    return this.run(async () => {
      const model = this.fromId(input); this.held(model);
      if (this.pending.has(model.id)) throw new ModelInventoryError("COMMITTED_UNCERTAIN");
      const original = await this.file(model), directory = await this.directoryFile();
      await directory.close();
      if (!sameFile((await this.file(model)).identity, original.identity)) throw new ModelInventoryError("MODEL_CHANGED");
      try { await this.io.unlink(join(this.directory, model.file)); }
      catch (error: unknown) {
        try { await lstat(join(this.directory, model.file)); }
        catch (check: unknown) { if (errorCode(check, "ENOENT")) {
          this.pending.set(model.id, { kind: "remove", model }); throw new ModelInventoryError("COMMITTED_UNCERTAIN");
        } throw check; }
        throw error;
      }
      this.pending.set(model.id, { kind: "remove", model });
      await this.finish(model.id);
    });
  }
  async import(sourceInput: unknown, optionsInput: unknown = {}): Promise<ImportedModel> {
    const sourceParsed = sourceSchema.safeParse(sourceInput), optionsParsed = importSchema.safeParse(optionsInput);
    if (!sourceParsed.success || !optionsParsed.success) throw new ModelInventoryError("INVALID_SOURCE");
    const source = sourceParsed.data, options = optionsParsed.data;
    const name = basename(source), extension = extname(name);
    const model = this.fromFile(`${extension ? name.slice(0, -extension.length) : name}.bin`);
    const receipt = options.receipt ? this.receipt(options.receipt) : undefined;
    if (receipt && (receipt.used || receipt.model.id !== model.id || receipt.model.file !== model.file)) throw new ModelInventoryError("INVALID_RECEIPT");
    const target = join(this.directory, model.file), temporary = join(this.directory, `.${randomUUID()}.model.part`);
    let original: InstalledModel | undefined;
    const owner = await this.run(async () => {
      if (receipt?.used) throw new ModelInventoryError("INVALID_RECEIPT");
      active(options.signal); await this.checkDirectory();
      if (this.importing) throw new ModelInventoryError("BUSY");
      if (this.pending.has(model.id)) throw new ModelInventoryError("COMMITTED_UNCERTAIN"); this.held(model);
      try { original = await this.file(model); } catch (error: unknown) {
        if (!(error instanceof ModelInventoryError && error.code === "NOT_INSTALLED")) throw error;
      }
      if (original && !options.replace) throw new ModelInventoryError("EXISTS");
      const installed = await this.scan();
      if (!original && !this.catalog.models.some((entry) => entry.id === model.id) && this.capacity(installed) >= MAX_INVENTORY_MODELS) throw new ModelInventoryError("CAPACITY");
      if (receipt) receipt.used = true;
      const started = { token: Symbol("owned import"), file: temporary, model }; this.importing = started; return started;
    });
    let input: FileHandle | undefined, output: FileHandle | undefined, part: ModelFileIdentity | undefined;
    let inputClosing: Promise<void> | undefined, outputClosing: Promise<void> | undefined;
    let published = false;
    try {
      input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await input.stat({ bigint: true });
      if (!before.isFile() || before.uid !== BigInt(process.getuid?.() ?? -1) || before.size < 1n || before.size > BigInt(MAX_MODEL_BYTES)) {
        throw new ModelInventoryError("INVALID_SOURCE");
      }
      await this.checkDirectory();
      output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      part = identity(await output.stat({ bigint: true }));
      const buffer = Buffer.alloc(MODEL_COPY_BYTES), digest = createHash("sha256"); let position = 0;
      while (position < Number(before.size)) {
        active(options.signal);
        const count = await this.io.read(input, buffer.subarray(0, Math.min(buffer.length, Number(before.size) - position)), position);
        if (!Number.isInteger(count) || count <= 0 || count > Math.min(buffer.length, Number(before.size) - position)) throw new ModelInventoryError("SOURCE_CHANGED");
        const bytes = buffer.subarray(0, count); await this.io.write(output, bytes); digest.update(bytes); position += count;
      }
      active(options.signal); await this.io.syncFile(output);
      const after = await input.stat({ bigint: true }), namedSource = await lstat(source, { bigint: true });
      if (!sameFile(identity(before), identity(after)) || !sameFile(identity(before), identity(namedSource)) || !namedSource.isFile()) {
        throw new ModelInventoryError("SOURCE_CHANGED");
      }
      const complete = await output.stat({ bigint: true });
      if (!ownedFile(complete) || complete.size !== before.size) throw new ModelInventoryError("STORAGE_FAILED");
      const completeFile = output;
      outputClosing = receipt ? receiptClose(completeFile) : completeFile.close(); await outputClosing; output = undefined;
      const copiedSha256 = digest.digest("hex");
      if (options.expected && (options.expected.bytes !== Number(complete.size) || options.expected.sha256 !== copiedSha256)) {
        throw new ModelInventoryError("INTEGRITY_FAILED");
      }
      const sourceFile = input;
      return await this.run(async () => {
        active(options.signal); await this.checkDirectory(); this.held(model);
        if (this.importing !== owner) throw new ModelInventoryError("BUSY");
        const finalSource = await sourceFile.stat({ bigint: true }), named = await lstat(source, { bigint: true });
        if (!sameFile(identity(before), identity(finalSource)) || !sameFile(identity(before), identity(named)) || !named.isFile()) {
          throw new ModelInventoryError("SOURCE_CHANGED");
        }
        const staged = await lstat(temporary, { bigint: true });
        if (!ownedFile(staged) || !sameFile(identity(staged), identity(complete))) throw new ModelInventoryError("MODEL_CHANGED");
        let current: InstalledModel | undefined;
        try { current = await this.file(model); } catch (error: unknown) {
          if (!(error instanceof ModelInventoryError && error.code === "NOT_INSTALLED")) throw error;
        }
        if (options.replace && ((original && (!current || !sameFile(current.identity, original.identity))) || (!original && current))) {
          throw new ModelInventoryError("MODEL_CHANGED");
        }
        // No source descriptor remains to fail cleanup after publication. Its
        // final FD/path identity check above still covers the complete copy.
        inputClosing = receipt ? receiptClose(sourceFile) : sourceFile.close(); await inputClosing; input = undefined;
        try {
          if (options.replace) await this.io.rename(temporary, target); else await this.io.link(temporary, target);
        } catch (error: unknown) {
          let named: BigIntStats | undefined;
          try { named = await lstat(target, { bigint: true }); } catch (check: unknown) { if (!errorCode(check, "ENOENT")) throw check; }
          if (named && sameInode(named, complete)) {
            published = true;
            const publication: Publication = { kind: "import", model, identity: identity(complete), temporary, copiedSha256, needsUnlink: !options.replace,
              ...(options.receipt ? { receipt: options.receipt } : {}) };
            if (receipt) receipt.publication = publication;
            this.pending.set(model.id, publication);
            throw new ModelInventoryError("COMMITTED_UNCERTAIN", options.receipt);
          }
          if (errorCode(error, "EEXIST")) throw new ModelInventoryError("EXISTS"); throw error;
        }
        published = true;
        const publication: Publication = { kind: "import", model, identity: identity(complete), temporary, copiedSha256, needsUnlink: !options.replace,
          ...(options.receipt ? { receipt: options.receipt } : {}) };
        if (receipt) receipt.publication = publication;
        this.pending.set(model.id, publication);
        const result = await this.finish(model.id);
        if (!result) throw new ModelInventoryError("COMMITTED_UNCERTAIN"); return result;
      });
    } catch (error: unknown) {
      if (published) throw new ModelInventoryError("COMMITTED_UNCERTAIN", options.receipt);
      if (error instanceof ModelInventoryError) throw error;
      throw new ModelInventoryError(errorCode(error, "ELOOP") ? "INVALID_SOURCE" : "STORAGE_FAILED");
    } finally {
      const closing: Promise<void>[] = [];
      if (input) closing.push(receipt ? inputClosing ??= receiptClose(input) : input.close());
      if (output) closing.push(receipt ? outputClosing ??= receiptClose(output) : output.close());
      if (receipt) {
        const closes = Promise.allSettled(closing);
        receipt.cleanup = async () => {
          const closed = await closes;
          if (closed.some((result) => result.status === "rejected")) throw new ModelInventoryError(published ? "COMMITTED_UNCERTAIN" : "STORAGE_FAILED", published ? options.receipt : undefined);
          await this.run(async () => {
            if (receipt.cleanupComplete) return;
            if (!published && part) await this.removePart(temporary, part);
            if (this.importing === owner) this.importing = undefined;
            receipt.cleanupComplete = true;
          });
        };
        try { await receipt.cleanup(); }
        catch (error: unknown) {
          if (published) throw new ModelInventoryError("COMMITTED_UNCERTAIN", options.receipt);
          if (error instanceof ModelInventoryError) throw error; throw new ModelInventoryError("STORAGE_FAILED");
        }
      } else {
      const closed = await Promise.allSettled(closing);
      try {
        await this.run(async () => {
          try { if (!published && part) await this.removePart(temporary, part); }
          finally { if (this.importing === owner) this.importing = undefined; }
        });
      } catch (error: unknown) {
        if (published) throw new ModelInventoryError("COMMITTED_UNCERTAIN");
        if (error instanceof ModelInventoryError) throw error; throw new ModelInventoryError("STORAGE_FAILED");
      }
      if (closed.some((result) => result.status === "rejected")) throw new ModelInventoryError(published ? "COMMITTED_UNCERTAIN" : "STORAGE_FAILED");
      }
    }
  }
}
