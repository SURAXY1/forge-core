// A minimal HTTP/1.1 server on raw TCP sockets. Handlers are synchronous: one parsed request in,
// one reply { status, type, body, headers } out. Keep-alive, pipelining, Content-Length and chunked
// request bodies, HEAD and Expect: 100-continue are handled here; nothing else of HTTP is needed.
import { createServer } from 'node:net';

const REASON = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 411: 'Length Required', 413: 'Payload Too Large', 422: 'Unprocessable Entity', 431: 'Request Header Fields Too Large', 500: 'Internal Server Error' };
const MAX_HEAD = 64 * 1024;
const MAX_BODY = 512 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');
const CRLF2 = Buffer.from('\r\n\r\n');

function parseHead(text) {
  const lineEnd = text.indexOf('\r\n');
  const first = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const a = first.indexOf(' ');
  const b = first.lastIndexOf(' ');
  if (a < 0 || b <= a) return null;
  const version = first.slice(b + 1);
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return null;
  const headers = {};
  let pos = lineEnd < 0 ? text.length : lineEnd + 2;
  while (pos < text.length) {
    let end = text.indexOf('\r\n', pos);
    if (end < 0) end = text.length;
    const colon = text.indexOf(':', pos);
    if (colon < 0 || colon > end) return null;
    const name = text.slice(pos, colon).toLowerCase();
    let v = colon + 1;
    while (v < end && (text.charCodeAt(v) === 32 || text.charCodeAt(v) === 9)) v++;
    let e = end;
    while (e > v && (text.charCodeAt(e - 1) === 32 || text.charCodeAt(e - 1) === 9)) e--;
    const value = text.slice(v, e);
    headers[name] = headers[name] === undefined ? value : headers[name] + ', ' + value;
    pos = end + 2;
  }
  return { method: first.slice(0, a), url: first.slice(a + 1, b), version, headers, body: EMPTY };
}

// Decode a chunked body starting at `pos`. Returns { body, next } or null when more bytes are needed.
function readChunked(buf, pos) {
  const parts = [];
  for (;;) {
    const eol = buf.indexOf('\r\n', pos, 'latin1');
    if (eol < 0) return buf.length - pos > 1024 ? { bad: true } : null;
    const sizeText = buf.latin1Slice(pos, eol).split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return { bad: true };
    const size = parseInt(sizeText, 16);
    const start = eol + 2;
    if (size === 0) {
      // skip optional trailers up to the blank line
      let at = start;
      for (;;) {
        const e = buf.indexOf('\r\n', at, 'latin1');
        if (e < 0) return null;
        if (e === at) return { body: parts.length === 1 ? parts[0] : Buffer.concat(parts), next: e + 2 };
        at = e + 2;
      }
    }
    if (buf.length < start + size + 2) return null;
    parts.push(buf.subarray(start, start + size));
    pos = start + size + 2;
  }
}

export function createHttpServer(handler) {
  const server = createServer({ noDelay: true, keepAlive: true }, (sock) => {
    let pending = null; // bytes not yet consumed
    let head = null; // parsed head waiting for its body
    let need = 0; // Content-Length of that body
    let chunks = null; // body pieces collected so far (Content-Length mode)
    let have = 0;
    let closing = false;

    const reply = (req, out) => {
      const status = out.status;
      const body = out.body === undefined || out.body === null ? EMPTY : out.body;
      const noBody = status === 204 || status === 304;
      const close = closing || req.version === 'HTTP/1.0' || /close/i.test(req.headers.connection || '');
      let text = 'HTTP/1.1 ' + status + ' ' + (REASON[status] || 'OK') + '\r\n';
      const extra = out.headers;
      if (extra) for (let i = 0; i < extra.length; i += 2) text += extra[i] + ': ' + extra[i + 1] + '\r\n';
      if (!noBody) {
        const len = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
        text += 'Content-Type: ' + out.type + '\r\nContent-Length: ' + len + '\r\n';
      }
      if (close) text += 'Connection: close\r\n';
      text += '\r\n';
      if (noBody || req.method === 'HEAD') sock.write(text, 'latin1');
      else if (typeof body === 'string') sock.write(text + body, 'utf8');
      else if (body.length < 16384) {
        const headLen = text.length;
        const all = Buffer.allocUnsafe(headLen + body.length);
        all.latin1Write(text, 0);
        body.copy(all, headLen);
        sock.write(all);
      } else {
        sock.cork();
        sock.write(text, 'latin1');
        sock.write(body);
        sock.uncork();
      }
      if (close) {
        closing = true;
        sock.end();
      }
    };

    const refuse = (status, message) => {
      closing = true;
      reply({ method: 'GET', version: 'HTTP/1.1', headers: {} }, { status, type: 'application/json; charset=utf-8', body: JSON.stringify({ message }), headers: ['X-GitHub-Request-Id', 'FFFF:00000000'] });
    };

    const run = (req) => {
      let out;
      try {
        out = handler(req);
      } catch (e) {
        out = { status: 500, type: 'application/json; charset=utf-8', body: JSON.stringify({ message: 'Internal error: ' + String((e && e.message) || e) }), headers: ['X-GitHub-Request-Id', 'FFFF:00000001'] };
      }
      reply(req, out);
    };

    const pump = () => {
      while (!closing) {
        if (head) {
          // Content-Length body still arriving
          if (have < need) return;
          const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
          const req = head;
          req.body = all.length === need ? all : all.subarray(0, need);
          pending = all.length > need ? all.subarray(need) : null;
          head = null;
          chunks = null;
          run(req);
          continue;
        }
        if (!pending || pending.length === 0) return;
        const end = pending.indexOf(CRLF2);
        if (end < 0) {
          if (pending.length > MAX_HEAD) refuse(431, 'Request header fields too large');
          return;
        }
        const req = parseHead(pending.latin1Slice(0, end));
        if (!req) return refuse(400, 'Bad Request');
        const bodyStart = end + 4;
        const h = req.headers;
        const te = h['transfer-encoding'];
        if (te !== undefined && /chunked/i.test(te)) {
          if (h.expect !== undefined && pending.length === bodyStart) sock.write(CONTINUE);
          const got = readChunked(pending, bodyStart);
          if (got === null) {
            if (pending.length > MAX_BODY) refuse(413, 'Payload too large');
            return;
          }
          if (got.bad) return refuse(400, 'Bad Request');
          req.body = got.body;
          pending = got.next < pending.length ? pending.subarray(got.next) : null;
          run(req);
          continue;
        }
        const cl = h['content-length'];
        if (cl === undefined || cl === '0') {
          pending = bodyStart < pending.length ? pending.subarray(bodyStart) : null;
          run(req);
          continue;
        }
        if (!/^\d+$/.test(cl)) return refuse(400, 'Bad Request');
        need = Number(cl);
        if (need > MAX_BODY) return refuse(413, 'Payload too large');
        const avail = pending.length - bodyStart;
        if (avail >= need) {
          req.body = pending.subarray(bodyStart, bodyStart + need);
          pending = avail > need ? pending.subarray(bodyStart + need) : null;
          run(req);
          continue;
        }
        if (h.expect !== undefined && avail === 0) sock.write(CONTINUE);
        head = req;
        chunks = avail > 0 ? [pending.subarray(bodyStart)] : [];
        have = avail;
        pending = null;
        return;
      }
    };

    sock.on('data', (chunk) => {
      if (closing) return;
      if (head) {
        chunks.push(chunk);
        have += chunk.length;
      } else pending = pending && pending.length ? Buffer.concat([pending, chunk]) : chunk;
      pump();
    });
    sock.on('error', () => sock.destroy());
  });
  return server;
}
