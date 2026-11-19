// Packfile reader and writer plus pkt-line framing.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { NUM_TYPE, TYPE_NUM, hashOf } from './gitobj.ts';

function applyDelta(base, delta) {
  let pos = 0;
  const readSize = () => {
    let size = 0;
    let shift = 0;
    let byte;
    do {
      byte = delta[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return size;
  };
  const baseSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const outSize = readSize();
  const out = Buffer.allocUnsafe(outSize);
  let at = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset += delta[pos++] * 0x1000000;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || at + size > outSize) throw new Error('delta copy out of range');
      base.copy(out, at, offset, offset + size);
      at += size;
    } else if (op) {
      if (pos + op > delta.length || at + op > outSize) throw new Error('delta insert out of range');
      delta.copy(out, at, pos, pos + op);
      pos += op;
      at += op;
    } else throw new Error('delta opcode 0');
  }
  if (at !== outSize) throw new Error('delta result size mismatch');
  return out;
}

// Parse a pack into [{type, data, oid}]. `lookup(oid)` resolves thin-pack bases held by the repository.
export function readPack(buf, lookup) {
  if (buf.length < 32 || buf.latin1Slice(0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version ' + version);
  const count = buf.readUInt32BE(8);
  const trailer = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(buf.subarray(buf.length - 20))) throw new Error('pack checksum mismatch');
  const end = buf.length - 20;
  const byOffset = new Map();
  const byOid = new Map();
  const pending = [];
  const out = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    if (pos >= end) throw new Error('truncated pack');
    let byte = buf[pos++];
    const typeNum = (byte >> 4) & 7;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = null;
    if (typeNum === 6) {
      byte = buf[pos++];
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++];
        off = (off + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - off;
    } else if (typeNum === 7) {
      baseOid = buf.hexSlice(pos, pos + 20);
      pos += 20;
    } else if (typeNum < 1 || typeNum > 4) throw new Error('bad pack object type ' + typeNum);
    const res = inflateSync(buf.subarray(pos, end), { info: true });
    pos += res.engine.bytesWritten;
    const data = res.buffer;
    if (typeNum <= 4) {
      const type = NUM_TYPE[typeNum];
      const entry = { type, data, oid: hashOf(type, data) };
      byOffset.set(start, entry);
      byOid.set(entry.oid, entry);
      out.push(entry);
    } else pending.push({ start, baseOffset, baseOid, delta: data });
  }
  // Resolve deltas; loop because a base may itself be a delta that appears later.
  let todo = pending;
  while (todo.length) {
    const rest = [];
    for (const d of todo) {
      let base = d.baseOffset >= 0 ? byOffset.get(d.baseOffset) : byOid.get(d.baseOid);
      if (!base && d.baseOid && lookup) base = lookup(d.baseOid);
      if (!base) {
        rest.push(d);
        continue;
      }
      const data = applyDelta(base.data, d.delta);
      const entry = { type: base.type, data, oid: hashOf(base.type, data) };
      byOffset.set(d.start, entry);
      byOid.set(entry.oid, entry);
      out.push(entry);
    }
    if (rest.length === todo.length) throw new Error('unresolvable delta base');
    todo = rest;
  }
  return out;
}

// The packed form of one object (header + zlib stream), cached on the object.
export function packedForm(obj) {
  if (obj.z) return obj.z;
  const size = obj.data.length;
  const head = [];
  let byte = (TYPE_NUM[obj.type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    head.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  head.push(byte);
  obj.z = Buffer.concat([Buffer.from(head), deflateSync(obj.data, { level: 1 })]);
  return obj.z;
}

export function writePack(objs) {
  const parts = [Buffer.alloc(12)];
  parts[0].write('PACK', 0, 'latin1');
  parts[0].writeUInt32BE(2, 4);
  parts[0].writeUInt32BE(objs.length, 8);
  const hash = createHash('sha1');
  hash.update(parts[0]);
  for (const o of objs) {
    const z = packedForm(o);
    hash.update(z);
    parts.push(z);
  }
  parts.push(hash.digest());
  return Buffer.concat(parts);
}

// ---- pkt-line
const HEX = '0123456789abcdef';
export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export function pkt(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const n = body.length + 4;
  const out = Buffer.allocUnsafe(n);
  out[0] = HEX.charCodeAt((n >> 12) & 15);
  out[1] = HEX.charCodeAt((n >> 8) & 15);
  out[2] = HEX.charCodeAt((n >> 4) & 15);
  out[3] = HEX.charCodeAt(n & 15);
  body.copy(out, 4);
  return out;
}

// Wrap bytes in side-band-64k frames on the given band.
export function sideband(band, data, parts) {
  const MAX = 65515;
  for (let at = 0; at < data.length; at += MAX) {
    const chunk = data.subarray(at, Math.min(data.length, at + MAX));
    const n = chunk.length + 5;
    const head = Buffer.allocUnsafe(5);
    head[0] = HEX.charCodeAt((n >> 12) & 15);
    head[1] = HEX.charCodeAt((n >> 8) & 15);
    head[2] = HEX.charCodeAt((n >> 4) & 15);
    head[3] = HEX.charCodeAt(n & 15);
    head[4] = band;
    parts.push(head, chunk);
  }
}

// Read pkt-lines from `pos` up to and including the first flush.
// Returns { items: [string | 'delim'], next } or throws on malformed framing.
export function readPkts(buf, pos) {
  const items = [];
  for (;;) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = parseInt(buf.latin1Slice(pos, pos + 4), 16);
    if (!/^[0-9a-fA-F]{4}$/.test(buf.latin1Slice(pos, pos + 4))) throw new Error('bad pkt-line length');
    if (len === 0) return { items, next: pos + 4 };
    if (len === 1) {
      items.push('delim');
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
    items.push(buf.utf8Slice(pos + 4, pos + len));
    pos += len;
  }
}
