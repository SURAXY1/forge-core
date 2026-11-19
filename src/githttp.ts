// Git smart HTTP: ref advertisement, protocol v2 upload-pack (ls-refs, fetch) and receive-pack.
import { ZERO, getCommit, getTree, peel, isAncestor } from './gitobj.ts';
import { readPack, writePack, pkt, sideband, readPkts, FLUSH, DELIM } from './pack.ts';
import { settleDefaultBranch, touchRepo, nowIso } from './store.ts';

const AGENT = 'agent=forge-core/1.0';
const V2_ADVERT = Buffer.concat([
  pkt('version 2\n'),
  pkt(AGENT + '\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow wait-for-done\n'),
  pkt('server-option\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);
const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1 ' + AGENT;
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta quiet object-format=sha1 ' + AGENT;

function sortedRefs(repo) {
  return [...repo.refs.keys()].sort();
}

function gitReply(status, type, body) {
  return { status, type, body, headers: ['Cache-Control', 'no-cache, max-age=0, must-revalidate'] };
}

export function advertise(repo, service, protocolHeader) {
  const type = 'application/x-' + service + '-advertisement';
  if (service === 'git-upload-pack' && /version=2/.test(protocolHeader || '')) return gitReply(200, type, V2_ADVERT);
  const parts = [pkt('# service=' + service + '\n'), FLUSH];
  const head = 'refs/heads/' + repo.defaultBranch;
  const headOid = repo.refs.get(head);
  const lines = [];
  if (service === 'git-upload-pack' && headOid) lines.push([headOid, 'HEAD']);
  for (const ref of sortedRefs(repo)) {
    const oid = repo.refs.get(ref);
    lines.push([oid, ref]);
    if (service === 'git-upload-pack') {
      const o = repo.objects.get(oid);
      if (o && o.type === 'tag') {
        const target = peel(repo.objects, oid);
        if (target) lines.push([target, ref + '^{}']);
      }
    }
  }
  let caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  if (service === 'git-upload-pack' && headOid) caps += ' symref=HEAD:' + head;
  if (lines.length === 0) parts.push(pkt(ZERO + ' capabilities^{}\0' + caps + '\n'));
  else {
    lines.forEach((l, i) => parts.push(pkt(l[0] + ' ' + l[1] + (i === 0 ? '\0' + caps : '') + '\n')));
  }
  parts.push(FLUSH);
  return gitReply(200, type, Buffer.concat(parts));
}

// ---- upload-pack (protocol v2)
function lsRefs(repo, args) {
  const prefixes = [];
  let wantPeel = false;
  let symrefs = false;
  let unborn = false;
  for (const a of args) {
    if (a === 'peel') wantPeel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
  }
  const match = (ref) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const parts = [];
  const head = 'refs/heads/' + repo.defaultBranch;
  const headOid = repo.refs.get(head);
  if (match('HEAD')) {
    if (headOid) parts.push(pkt(headOid + ' HEAD' + (symrefs ? ' symref-target:' + head : '') + '\n'));
    else if (unborn) parts.push(pkt('unborn HEAD' + (symrefs ? ' symref-target:' + head : '') + '\n'));
  }
  for (const ref of sortedRefs(repo)) {
    if (!match(ref)) continue;
    const oid = repo.refs.get(ref);
    let line = oid + ' ' + ref;
    if (wantPeel) {
      const o = repo.objects.get(oid);
      if (o && o.type === 'tag') {
        const target = peel(repo.objects, oid);
        if (target) line += ' peeled:' + target;
      }
    }
    parts.push(pkt(line + '\n'));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// Mark every object under a tree as already present on the client.
function markTree(objects, treeOid, seen) {
  if (seen.has(treeOid)) return;
  seen.add(treeOid);
  const entries = getTree(objects, treeOid);
  if (!entries) return;
  for (const e of entries) {
    if (e.mode === '40000') markTree(objects, e.oid, seen);
    else seen.add(e.oid);
  }
}

function collectTree(objects, treeOid, seen, out) {
  if (seen.has(treeOid)) return;
  seen.add(treeOid);
  const o = objects.get(treeOid);
  if (!o) return;
  out.push(o);
  for (const e of getTree(objects, treeOid) || []) {
    if (e.mode === '40000') collectTree(objects, e.oid, seen, out);
    else if (e.mode !== '160000' && !seen.has(e.oid)) {
      seen.add(e.oid);
      const b = objects.get(e.oid);
      if (b) out.push(b);
    }
  }
}

function fetchCmd(repo, args) {
  const objects = repo.objects;
  const wants = [];
  const haves = [];
  const clientShallow = new Set();
  let depth = 0;
  let done = false;
  let waitForDone = false;
  let relative = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5, 45));
    else if (a.startsWith('have ')) haves.push(a.slice(5, 45));
    else if (a.startsWith('shallow ')) clientShallow.add(a.slice(8, 48));
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10) || 0;
    else if (a === 'deepen-relative') relative = true;
    else if (a === 'done') done = true;
    else if (a === 'wait-for-done') waitForDone = true;
  }
  for (const w of wants) {
    if (!objects.has(w)) return Buffer.concat([pkt('ERR upload-pack: not our ref ' + w + '\n'), FLUSH]);
  }
  if (relative && depth > 0 && clientShallow.size) {
    // Measure how deep the client's boundary sits below the wants, then extend past it.
    let level = wants.map((w) => peel(objects, w)).filter(Boolean);
    const seenLevel = new Set(level);
    let n = 1;
    let deepest = 0;
    while (level.length && n < 100000) {
      const next = [];
      for (const oid of level) {
        if (clientShallow.has(oid)) {
          deepest = n;
          continue;
        }
        const c = getCommit(objects, oid);
        if (c) for (const p of c.parents) if (!seenLevel.has(p)) { seenLevel.add(p); next.push(p); }
      }
      level = next;
      n++;
    }
    depth += deepest;
  }
  const parts = [];
  const common = haves.filter((h) => objects.has(h));
  if (!done) {
    parts.push(pkt('acknowledgments\n'));
    if (common.length === 0) parts.push(pkt('NAK\n'));
    else for (const h of common) parts.push(pkt('ACK ' + h + '\n'));
    if (wants.length === 0 || waitForDone || (common.length === 0 && haves.length > 0)) {
      // Negotiation only: no pack yet, the client will come back with more haves or `done`.
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }
    parts.push(pkt('ready\n'), DELIM);
  }

  // Commits the client already holds: reachable from its haves without crossing its shallow boundary.
  const haveCommits = new Set();
  const seen = new Set();
  {
    const stack = [];
    for (const h of common) {
      const target = peel(objects, h);
      seen.add(h);
      if (target && getCommit(objects, target)) stack.push(target);
      else if (target) markTree(objects, target, seen);
    }
    while (stack.length) {
      const oid = stack.pop();
      if (haveCommits.has(oid)) continue;
      haveCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      const c = getCommit(objects, oid);
      if (c) for (const p of c.parents) if (!haveCommits.has(p)) stack.push(p);
    }
  }

  // Commits to send, breadth first from the wants, cut at `depth` when deepening.
  const out = [];
  const send = [];
  const boundary = [];
  const reached = new Map(); // commit -> level
  let level = [];
  for (const w of wants) {
    let cur = w;
    for (let i = 0; i < 16; i++) {
      const o = objects.get(cur);
      if (!o) break;
      if (o.type === 'tag') {
        if (!seen.has(cur)) {
          seen.add(cur);
          out.push(o);
        }
        const m = /^object ([0-9a-f]{40})/.exec(o.data.latin1Slice(0, 60));
        if (!m) break;
        cur = m[1];
        continue;
      }
      if (o.type === 'commit') {
        if (!reached.has(cur)) {
          reached.set(cur, 1);
          level.push(cur);
        }
      } else if (o.type === 'tree') collectTree(objects, cur, seen, out);
      else if (!seen.has(cur)) {
        seen.add(cur);
        out.push(o);
      }
      break;
    }
  }
  let n = 1;
  while (level.length) {
    const next = [];
    for (const oid of level) {
      const c = getCommit(objects, oid);
      if (!c) continue;
      if (depth > 0) {
        if (n >= depth) {
          if (c.parents.length) boundary.push(oid);
          if (!haveCommits.has(oid)) send.push(oid);
          continue;
        }
        // Inside the new depth: a commit the client held shallow is sent again only via its parents.
        if (!haveCommits.has(oid)) send.push(oid);
      } else {
        if (haveCommits.has(oid) && !clientShallow.has(oid)) continue;
        if (!haveCommits.has(oid)) send.push(oid);
        if (clientShallow.has(oid)) continue;
      }
      for (const p of c.parents) {
        if (!reached.has(p)) {
          reached.set(p, n + 1);
          next.push(p);
        }
      }
    }
    level = next;
    n++;
  }

  if (depth > 0 || clientShallow.size) {
    const info = [];
    if (depth > 0) {
      const edge = new Set(boundary);
      for (const oid of boundary) if (!clientShallow.has(oid)) info.push(pkt('shallow ' + oid + '\n'));
      for (const oid of clientShallow) if (reached.has(oid) && !edge.has(oid)) info.push(pkt('unshallow ' + oid + '\n'));
    }
    if (info.length) parts.push(pkt('shallow-info\n'), ...info, DELIM);
  }

  // Trees the client is known to hold: its have tips and the have-side parents of what we send.
  const sendSet = new Set(send);
  for (const h of common) {
    const target = peel(objects, h);
    const c = target && getCommit(objects, target);
    if (c) markTree(objects, c.tree, seen);
  }
  for (const oid of send) {
    const c = getCommit(objects, oid);
    for (const p of c.parents) {
      if (!sendSet.has(p) && haveCommits.has(p)) {
        const pc = getCommit(objects, p);
        if (pc) markTree(objects, pc.tree, seen);
      }
    }
  }
  for (const oid of send) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    out.push(objects.get(oid));
    collectTree(objects, getCommit(objects, oid).tree, seen, out);
  }
  parts.push(pkt('packfile\n'));
  sideband(1, writePack(out), parts);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(repo, body) {
  const type = 'application/x-git-upload-pack-result';
  let parsed;
  try {
    parsed = readPkts(body, 0);
  } catch (e) {
    return { status: 400, type: 'text/plain', body: 'malformed upload-pack request: ' + e.message + '\n' };
  }
  const items = parsed.items.map((s) => (s.endsWith('\n') ? s.slice(0, -1) : s));
  const first = items[0] || '';
  if (!first.startsWith('command=')) {
    return { status: 400, type: 'text/plain', body: 'upload-pack: only protocol version 2 is served (send Git-Protocol: version=2)\n' };
  }
  const delim = items.indexOf('delim');
  const args = delim < 0 ? [] : items.slice(delim + 1);
  const command = first.slice(8);
  if (command === 'ls-refs' || command === 'fetch') {
    // Identical requests against unchanged refs get the identical bytes back.
    const key = body.latin1Slice();
    let hit = repo.fetchCache && repo.fetchCache.get(key);
    if (!hit) {
      hit = gitReply(200, type, command === 'fetch' ? fetchCmd(repo, args) : lsRefs(repo, args));
      if (!repo.fetchCache) repo.fetchCache = new Map();
      if (repo.fetchCache.size < 64) repo.fetchCache.set(key, hit);
    }
    return hit;
  }
  return gitReply(200, type, Buffer.concat([pkt('ERR unknown command ' + command + '\n'), FLUSH]));
}

// ---- receive-pack
export function receivePack(repo, body) {
  const type = 'application/x-git-receive-pack-result';
  let parsed;
  try {
    parsed = readPkts(body, 0);
  } catch (e) {
    return { status: 400, type: 'text/plain', body: 'malformed receive-pack request: ' + e.message + '\n' };
  }
  const commands = [];
  let caps = '';
  for (let raw of parsed.items) {
    if (raw === 'delim') continue;
    const nul = raw.indexOf('\0');
    if (nul >= 0) {
      if (commands.length === 0) caps = raw.slice(nul + 1);
      raw = raw.slice(0, nul);
    }
    if (raw.endsWith('\n')) raw = raw.slice(0, -1);
    if (raw.startsWith('shallow ') || raw.startsWith('push-option')) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(raw);
    if (!m) return { status: 400, type: 'text/plain', body: 'malformed receive-pack command\n' };
    commands.push({ old: m[1], neu: m[2], ref: m[3] });
  }
  if (commands.length === 0) return { status: 400, type: 'text/plain', body: 'receive-pack: no commands\n' };
  const objects = repo.objects;
  let unpack = 'ok';
  const packBytes = body.subarray(parsed.next);
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, (oid) => objects.get(oid));
      for (const e of entries) if (!objects.has(e.oid)) objects.set(e.oid, { type: e.type, data: e.data, z: null, parsed: null });
    } catch (e) {
      unpack = String(e.message || e).replace(/\s+/g, ' ');
    }
  }
  const lines = [pkt('unpack ' + unpack + '\n')];
  let changed = false;
  for (const c of commands) {
    let why = null;
    const cur = repo.refs.get(c.ref) || null;
    if (unpack !== 'ok') why = 'unpacker error';
    else if (!/^refs\/[^\s~^:?*\[\\]+$/.test(c.ref) || c.ref.includes('..') || c.ref.endsWith('/') || c.ref.endsWith('.lock')) why = 'funny refname';
    else if (c.neu === ZERO) {
      if (!cur) why = 'no such ref';
      else if (c.ref === 'refs/heads/' + repo.defaultBranch) why = 'refusing to delete the current branch';
      else {
        repo.refs.delete(c.ref);
        changed = true;
      }
    } else if (!objects.has(c.neu)) why = 'missing necessary objects';
    else {
      if (cur && cur !== c.neu && c.ref.startsWith('refs/heads/')) {
        const tip = peel(objects, c.neu);
        if (!tip || !isAncestor(objects, cur, tip)) why = 'non-fast-forward';
      } else if (!cur && c.old !== ZERO && c.ref.startsWith('refs/heads/')) {
        // The client believed the ref existed; creating it from scratch is still a plain create.
      }
      if (!why && c.ref.startsWith('refs/heads/')) {
        const o = objects.get(c.neu);
        if (!o || o.type !== 'commit') why = 'branch tip is not a commit';
      }
      if (!why) {
        repo.refs.set(c.ref, c.neu);
        changed = true;
      }
    }
    lines.push(pkt(why ? 'ng ' + c.ref + ' ' + why + '\n' : 'ok ' + c.ref + '\n'));
  }
  lines.push(FLUSH);
  if (changed) {
    repo.fetchCache = null;
    settleDefaultBranch(repo);
    repo.pushedAt = nowIso();
    touchRepo(repo);
  }
  const report = Buffer.concat(lines);
  if (!/\breport-status/.test(caps)) return gitReply(200, type, Buffer.alloc(0));
  if (!/\bside-band(-64k)?\b/.test(caps)) return gitReply(200, type, report);
  const parts = [];
  sideband(1, report, parts);
  parts.push(FLUSH);
  return gitReply(200, type, Buffer.concat(parts));
}
