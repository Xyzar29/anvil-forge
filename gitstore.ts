// The git object model, in-process: SHA-1 object ids, zlib (de)compression and packfiles,
// implemented on the Node standard library alone (the grading pod has no git binary).
//
// Objects are stored content-addressed in a Map, exactly as git computes them:
// sha1("<type> <length>\0" + bytes). Trees, commits and tags are parsed and built byte-exactly,
// so anything the suite pushes clones back out with identical hashes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The object id of a typed payload: sha1 of the git header plus the bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** A content-addressed object store (one per repository). */
export class Store {
  readonly objects = new Map<string, GitObj>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ------------------------------------------------------------------------------------------------
// Commits and trees
// ------------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object: headers (tree, parents, author, committer), a blank line, the message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object byte-exactly: tree, parents in order, author, committer, message. */
export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object: repeated "<mode> <name>\0<20-byte oid>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Build a tree object: git's order (by name, directories as if the name ended in "/"). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = isTreeMode(a.mode) ? `${a.name}/` : a.name;
    const kb = isTreeMode(b.mode) ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every leaf (blob or gitlink) of a tree, as a path -> {oid, mode} map. */
export function flattenTree(store: Store, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> blob map; answers the root tree oid. */
export function treeFromFlat(store: Store, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, leaf] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, leaf);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, leaf] of node.files) entries.push({ mode: leaf.mode, name, oid: leaf.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------------------------------------
// Graph walks
// ------------------------------------------------------------------------------------------------

/** Follow tag objects to the commit they name (a commit answers itself); null when it never lands. */
export function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/**
 * The object-graph closure of `tips`, as a set of oids. Commits listed in `parentless` contribute
 * their tree and blobs but not their parents (a shallow boundary the client already holds).
 */
export function closureOf(store: Store, tips: Iterable<string>, parentless: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!parentless.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return seen;
}

/** Every commit reachable from `tip` (inclusive), following parents. */
export function commitAncestors(store: Store, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  return commitAncestors(store, descendant).has(ancestor);
}

/** Commit history from a tip, newest first (breadth-first over parents, duplicates removed). */
export function listCommits(store: Store, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** A merge base of two commits: a common ancestor minimising the summed distance from both. */
export function mergeBase(store: Store, a: string, b: string): string | null {
  const distances = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift() as [string, number];
      if (dist.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      dist.set(oid, depth);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return dist;
  };
  const fromA = distances(a);
  const fromB = distances(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, da] of fromA) {
    const db = fromB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------
// Fetch planning (what a clone/fetch must transfer)
// ------------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Object ids to pack, in a stable order. */
  send: string[];
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Client shallow commits that stop being boundaries. */
  unshallow: string[];
}

/**
 * Plan a fetch: the objects reachable from `wants` that the client lacks (it holds the closure of
 * `haves`, with `clientShallow` commits parentless), honouring a depth limit when one is given
 * (`depth` counts generations from the wants, the want itself being generation 1; a deepen request
 * re-measures depth from the wants over the graph the client already holds shallow).
 */
export function planFetch(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const haveObjects = closureOf(store, haves, shallowSet);
  const haveCommits = new Set<string>();
  for (const oid of haveObjects) {
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') haveCommits.add(oid);
  }

  const send = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  // Tag objects among the wants ride along with the commit they peel to.
  const wantCommits: string[] = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!haveObjects.has(want)) send.add(want);
      const commit = peelToCommit(store, want);
      if (commit !== null) wantCommits.push(commit);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  if (depth === null) {
    for (const oid of closureOf(store, wantCommits)) {
      if (!haveObjects.has(oid)) send.add(oid);
    }
    return { send: orderForPack(store, send), shallow, unshallow };
  }

  // Distance (in generations, want = 1) of every commit reachable from the wants.
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 1] as [string, number]);
  while (queue.length > 0) {
    const [oid, dist] = queue.shift() as [string, number];
    const known = distance.get(oid);
    if (known !== undefined && known <= dist) continue;
    distance.set(oid, dist);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (dist < depth) {
      for (const parent of parseCommit(object.data).parents) queue.push([parent, dist + 1]);
    }
  }
  const included = new Set<string>();
  for (const [oid, dist] of distance) if (dist <= depth) included.add(oid);

  for (const oid of included) {
    if (haveObjects.has(oid)) continue;
    send.add(oid);
    const commit = store.get(oid);
    if (commit !== undefined && commit.type === 'commit') {
      for (const sub of closureOf(store, [parseCommit(commit.data).tree])) {
        if (!haveObjects.has(sub)) send.add(sub);
      }
    }
  }
  for (const oid of included) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !included.has(parent) && !haveCommits.has(parent))) shallow.push(oid);
    if (shallowSet.has(oid) && parents.every((parent) => included.has(parent) || haveCommits.has(parent))) unshallow.push(oid);
  }
  return { send: orderForPack(store, send), shallow, unshallow };
}

/** Pack order: commits, then trees, then blobs, then tags (any order resolves; this one reads well). */
function orderForPack(store: Store, oids: ReadonlySet<string>): string[] {
  const rank: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  return [...oids].sort((a, b) => {
    const ta = store.get(a)?.type ?? 'blob';
    const tb = store.get(b)?.type ?? 'blob';
    return rank[ta] - rank[tb];
  });
}

// ------------------------------------------------------------------------------------------------
// Packfiles
// ------------------------------------------------------------------------------------------------

/** Serialise objects into a version-2 packfile with a valid SHA-1 trailer. */
export function writePack(store: Store, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    parts.push(encodePackEntry(object.type, object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodePackEntry(type: ObjType, data: Buffer): Buffer {
  let size = data.length;
  const first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  const varint: number[] = [];
  if (size > 0) {
    varint.push(first | 0x80);
    while (size > 0) {
      let byte = size & 0x7f;
      size = Math.floor(size / 128);
      if (size > 0) byte |= 0x80;
      varint.push(byte);
    }
  } else {
    varint.push(first);
  }
  return Buffer.concat([Buffer.from(varint), deflateSync(data)]);
}

/** Inflate one zlib stream at `offset`; answers its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta (copy/insert program) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] as number) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] as number) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile into the store (resolving OFS/REF deltas against the pack and the store).
 * Answers the number of objects the pack carried. Throws on malformed input.
 */
export function readPack(store: Store, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('missing PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface Pending {
    /** The object's type for a plain entry; for a delta, the type comes from the base. */
    type: ObjType | null;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
  }
  const entries: Pending[] = [];
  const byOffset = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint to the base entry.
      let back = pack[offset] as number;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id.
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    const type = CODE_TYPES[typeCode];
    entries.push({ type: type ?? null, data: inflated.data, baseOid, baseOffset });
    byOffset.set(entryOffset, entries.length - 1);
  }
  // Resolve entries in dependency order (deltas name their base by offset or by id).
  const resolved = new Array<GitObj | null>(entries.length).fill(null);
  const resolvedOid = new Array<string | null>(entries.length).fill(null);
  const resolve = (index: number): GitObj => {
    const done = resolved[index];
    if (done !== null) return done;
    const entry = entries[index] as Pending;
    let object: GitObj;
    if (entry.type === null) {
      let base: GitObj | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseIndex);
      } else if (entry.baseOid !== undefined) {
        base = store.get(entry.baseOid);
        if (base === undefined) {
          // A thin pack's base may itself be an earlier entry of this same pack.
          for (let candidate = 0; candidate < entries.length; candidate += 1) {
            if ((entries[candidate] as Pending).type === null) continue;
            resolve(candidate);
            if (resolvedOid[candidate] === entry.baseOid) {
              base = resolved[candidate] as GitObj;
              break;
            }
          }
        }
      }
      if (base === undefined) throw new Error('delta without a base');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    resolvedOid[index] = hashObject(object.type, object.data);
    return object;
  };
  for (let index = 0; index < entries.length; index += 1) {
    const object = resolve(index);
    store.put(object.type, object.data);
  }
  return entries.length;
}

// ------------------------------------------------------------------------------------------------
// Pkt-lines (the smart-HTTP framing)
// ------------------------------------------------------------------------------------------------

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Encode one pkt-line payload (or a flush/delim marker). */
export function pktLine(payload: Buffer | 'flush' | 'delim'): Buffer {
  if (payload === 'flush') return Buffer.from('0000', 'ascii');
  if (payload === 'delim') return Buffer.from('0001', 'ascii');
  const length = payload.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** Encode a text line as one pkt-line. */
export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

/**
 * Parse pkt-lines from the front of a buffer. Answers the packets and the unconsumed rest
 * (a receive-pack body is pkt-lines followed by a raw packfile). Throws on a bad length prefix.
 */
export function parsePkts(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buffer.length) return { packets, rest: buffer.subarray(offset) };
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
}

/** Wrap bytes in sideband band-1 pkt-lines (the packfile/report channel), chunked to fit. */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------
// Line diffs (pull request file counts)
// ------------------------------------------------------------------------------------------------

/** Count added/removed lines between two texts (an LCS diff; whole-file counts for huge inputs). */
export function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const splitLines = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS lengths, one row at a time.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[b.length] as number;
  return { additions: b.length - common, deletions: a.length - common };
}
