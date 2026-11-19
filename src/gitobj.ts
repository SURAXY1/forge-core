// Git object model: hashing, tree and commit codecs, and path-level tree editing.
// Objects live in a per-repository Map keyed by hex object id.
import { createHash } from 'node:crypto';

export const ZERO = '0000000000000000000000000000000000000000';
export const TYPE_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE = [null, 'commit', 'tree', 'blob', 'tag'];

export function hashOf(type, data) {
  const h = createHash('sha1');
  h.update(type + ' ' + data.length + '\0');
  h.update(data);
  return h.digest('hex');
}

// Store one object in a repository's object map and return its id.
export function putObject(objects, type, data) {
  const oid = hashOf(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data, z: null, parsed: null });
  return oid;
}

export function parseTreeData(data) {
  const out = [];
  let pos = 0;
  const len = data.length;
  while (pos < len) {
    const sp = data.indexOf(0x20, pos);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > len) throw new Error('corrupt tree');
    out.push({
      mode: data.latin1Slice(pos, sp),
      name: data.utf8Slice(sp + 1, nul),
      oid: data.hexSlice(nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return out;
}

function sortKey(e) {
  return e.mode === '40000' || e.mode === '040000' ? e.name + '/' : e.name;
}

export function buildTreeData(entries) {
  const sorted = entries.slice().sort((a, b) => {
    const x = Buffer.from(sortKey(a));
    const y = Buffer.from(sortKey(b));
    return Buffer.compare(x, y);
  });
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from((e.mode === '040000' ? '40000' : e.mode) + ' ' + e.name + '\0'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommitData(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const c = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
  }
  return c;
}

// "Name <email> 1700000000 +0000" -> { name, email, date }
export function parseIdent(line) {
  const m = /^(.*?) <([^>]*)> (\d+)(?: ([+-]\d{4}))?$/.exec(line || '');
  if (!m) return { name: line || '', email: '', date: new Date(0).toISOString().replace('.000Z', 'Z'), time: 0 };
  const time = Number(m[3]);
  return { name: m[1], email: m[2], time, date: new Date(time * 1000).toISOString().replace('.000Z', 'Z') };
}

export function getCommit(objects, oid) {
  const o = objects.get(oid);
  if (!o || o.type !== 'commit') return null;
  if (!o.parsed) o.parsed = parseCommitData(o.data);
  return o.parsed;
}

export function getTree(objects, oid) {
  const o = objects.get(oid);
  if (!o || o.type !== 'tree') return null;
  if (!o.parsed) o.parsed = parseTreeData(o.data);
  return o.parsed;
}

// Peel tags down to the object they finally name.
export function peel(objects, oid) {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const o = objects.get(cur);
    if (!o) return null;
    if (o.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})/.exec(o.data.latin1Slice(0, 60));
    if (!m) return null;
    cur = m[1];
  }
  return null;
}

export function makeCommit(objects, { tree, parents, author, committer, message }) {
  let text = 'tree ' + tree + '\n';
  for (const p of parents) text += 'parent ' + p + '\n';
  text += 'author ' + author + '\ncommitter ' + (committer || author) + '\n\n' + message;
  return putObject(objects, 'commit', Buffer.from(text, 'utf8'));
}

// Find the entry at a slash-separated path under a tree; '' names the tree itself.
export function lookupPath(objects, treeOid, path) {
  if (path === '') return { mode: '40000', oid: treeOid };
  const parts = path.split('/');
  let cur = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const entries = getTree(objects, cur);
    if (!entries) return null;
    const hit = entries.find((e) => e.name === parts[i]);
    if (!hit) return null;
    if (i === parts.length - 1) return hit;
    if (hit.mode !== '40000') return null;
    cur = hit.oid;
  }
  return null;
}

// Return a new tree id with the blob at `parts` replaced (blobOid) or removed (null).
// A directory left empty disappears; null means the whole tree became empty.
export function editTree(objects, treeOid, parts, blobOid, mode = '100644') {
  const entries = treeOid ? (getTree(objects, treeOid) || []).slice() : [];
  const name = parts[0];
  const at = entries.findIndex((e) => e.name === name);
  if (parts.length === 1) {
    if (blobOid === null) {
      if (at >= 0) entries.splice(at, 1);
    } else if (at >= 0) entries[at] = { mode: entries[at].mode === '40000' ? mode : entries[at].mode, name, oid: blobOid };
    else entries.push({ mode, name, oid: blobOid });
  } else {
    const sub = at >= 0 && entries[at].mode === '40000' ? entries[at].oid : null;
    const next = editTree(objects, sub, parts.slice(1), blobOid, mode);
    if (next === null) {
      if (at >= 0) entries.splice(at, 1);
    } else if (at >= 0) entries[at] = { mode: '40000', name, oid: next };
    else entries.push({ mode: '40000', name, oid: next });
  }
  if (entries.length === 0) return null;
  return putObject(objects, 'tree', buildTreeData(entries));
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function ensureEmptyTree(objects) {
  return putObject(objects, 'tree', Buffer.alloc(0));
}

// Flatten a tree to Map(path -> {mode, oid}) of blobs.
export function flatten(objects, treeOid, prefix = '', out = new Map()) {
  const entries = treeOid ? getTree(objects, treeOid) : null;
  if (!entries) return out;
  for (const e of entries) {
    if (e.mode === '40000') flatten(objects, e.oid, prefix + e.name + '/', out);
    else out.set(prefix + e.name, { mode: e.mode, oid: e.oid });
  }
  return out;
}

// Build a tree from Map(path -> {mode, oid}); returns the root tree id.
export function treeFromFlat(objects, flat) {
  const root = { dirs: new Map(), files: [] };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) node.dirs.set(parts[i], (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push({ mode: v.mode, name: parts[parts.length - 1], oid: v.oid });
  }
  const write = (node) => {
    const entries = node.files.slice();
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    return putObject(objects, 'tree', buildTreeData(entries));
  };
  return write(root);
}

// Is `ancestor` reachable from `tip` by parent links?
export function isAncestor(objects, ancestor, tip) {
  if (ancestor === tip) return true;
  const seen = new Set([tip]);
  const stack = [tip];
  while (stack.length) {
    const c = getCommit(objects, stack.pop());
    if (!c) continue;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

export function mergeBase(objects, a, b) {
  if (a === b) return a;
  const seen = new Set();
  let stack = [a];
  while (stack.length) {
    const oid = stack.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = getCommit(objects, oid);
    if (c) for (const p of c.parents) stack.push(p);
  }
  let queue = [b];
  const visited = new Set();
  while (queue.length) {
    const next = [];
    for (const oid of queue) {
      if (visited.has(oid)) continue;
      visited.add(oid);
      if (seen.has(oid)) return oid;
      const c = getCommit(objects, oid);
      if (c) for (const p of c.parents) next.push(p);
    }
    queue = next;
  }
  return null;
}

// Commits reachable from tip, newest first (by committer time, stable on ties), up to `limit`.
export function walkHistory(objects, tip, limit = 1e9) {
  const out = [];
  const seen = new Set([tip]);
  let frontier = [tip];
  while (frontier.length && out.length < limit) {
    let best = 0;
    let bestTime = -1;
    for (let i = 0; i < frontier.length; i++) {
      const c = getCommit(objects, frontier[i]);
      const t = c ? parseIdent(c.committer).time : 0;
      if (t > bestTime) {
        bestTime = t;
        best = i;
      }
    }
    const oid = frontier.splice(best, 1)[0];
    const c = getCommit(objects, oid);
    if (!c) continue;
    out.push(oid);
    for (const p of c.parents) {
      if (!seen.has(p)) {
        seen.add(p);
        frontier.push(p);
      }
    }
  }
  return out;
}
