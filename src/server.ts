// HTTP front door: authentication, body collection and dispatch to REST, GraphQL, MCP and git smart HTTP.
import { createHttpServer } from './httpd.ts';
import { gunzipSync, inflateSync } from 'node:zlib';
import { ApiError, findRepo } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { advertise, uploadPack, receivePack } from './githttp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || '';
const BEARER = 'Bearer ' + TOKEN;
let requestSeq = 0;
const SEED = Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');

function authorized(header) {
  if (!header) return false;
  if (TOKEN !== '' && header === BEARER) return true;
  const sp = header.indexOf(' ');
  if (sp < 0) return false;
  const scheme = header.slice(0, sp).toLowerCase();
  const value = header.slice(sp + 1).trim();
  if (value === '') return false;
  if (scheme === 'bearer' || scheme === 'token') return TOKEN === '' || value === TOKEN;
  if (scheme === 'basic') {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    const user = colon < 0 ? text : text.slice(0, colon);
    const pass = colon < 0 ? '' : text.slice(colon + 1);
    if (TOKEN === '') return text.length > 1;
    return pass === TOKEN || user === TOKEN;
  }
  return false;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function send(res, status, type, body, extra) {
  const id = SEED + ':' + (++requestSeq).toString(16).toUpperCase().padStart(8, '0');
  const headers = ['X-GitHub-Request-Id', id];
  if (extra) for (let i = 0; i < extra.length; i++) headers.push(extra[i]);
  return { status, type, body, headers };
}

const API_HEADERS = ['X-GitHub-Media-Type', 'github.v3; format=json', 'X-OAuth-Scopes', 'repo, read:org'];

function sendError(res, status, message, errors) {
  const body = { message, documentation_url: 'https://docs.github.com/rest', status: String(status) };
  if (errors) body.errors = errors;
  return send(res, status, JSON_TYPE, JSON.stringify(body), status === 401 ? ['WWW-Authenticate', 'Basic realm="forge-core"'] : undefined);
}

function decodeBody(req) {
  let body = req.body;
  const enc = req.headers['content-encoding'];
  if (enc && body.length) {
    if (/gzip/i.test(enc)) body = gunzipSync(body);
    else if (/deflate/i.test(enc)) body = inflateSync(body);
  }
  return body;
}

function splitSegs(path) {
  const out = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    if (raw.indexOf('%') < 0) out.push(raw);
    else {
      try {
        out.push(decodeURIComponent(raw));
      } catch {
        out.push(raw);
      }
    }
  }
  return out;
}

function gitRoute(req, res, path, queryText, body) {
  // /{owner}/{repo}[.git]/info/refs | git-upload-pack | git-receive-pack
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  if (!authorized(req.headers.authorization)) {
    return send(res, 401, 'text/plain', 'Authentication required\n', ['WWW-Authenticate', 'Basic realm="forge-core"']);
  }
  let owner = m[1];
  let name = m[2];
  try {
    owner = decodeURIComponent(owner);
    name = decodeURIComponent(name);
  } catch {}
  const repo = findRepo(owner, name);
  if (!repo) {
    return send(res, 404, 'text/plain', 'Repository not found.\n');
  }
  let out;
  if (m[3] === 'info/refs') {
    const service = new URLSearchParams(queryText).get('service');
    if (req.method !== 'GET' && req.method !== 'HEAD') out = { status: 405, type: 'text/plain', body: 'method not allowed\n' };
    else if (service !== 'git-upload-pack' && service !== 'git-receive-pack') out = { status: 403, type: 'text/plain', body: 'dumb HTTP transport is not served; use smart HTTP\n' };
    else out = advertise(repo, service, req.headers['git-protocol']);
  } else if (req.method !== 'POST') out = { status: 405, type: 'text/plain', body: 'method not allowed\n' };
  else if (m[3] === 'git-upload-pack') out = uploadPack(repo, body);
  else out = receivePack(repo, body);
  return send(res, out.status, out.type, out.body, out.headers);
}

function dispatch(req) {
  const res = null;
  const url = req.url || '/';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const queryText = q < 0 ? '' : url.slice(q + 1);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (path === '/healthz') return send(res, 200, JSON_TYPE, '{"ok":true}');
  const isApi = path.startsWith('/api/v3') && (path.length === 7 || path.charCodeAt(7) === 47);
  const isGql = path === '/api/graphql' || path === '/graphql' || path === '/api/v3/graphql';
  const isMcp = path === '/mcp' || path === '/mcp/';
  try {
    if (!isApi && !isGql && !isMcp) {
      let body;
      try {
        body = decodeBody(req);
      } catch {
        return send(res, 400, 'text/plain', 'request body could not be decoded\n');
      }
      const git = gitRoute(req, res, path, queryText, body);
      if (git) return git;
      if (!authorized(req.headers.authorization)) return sendError(res, 401, 'Requires authentication');
      return sendError(res, 404, 'Not Found');
    }
    if (!authorized(req.headers.authorization)) {
      if (isMcp) return send(res, 401, JSON_TYPE, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } }), ['WWW-Authenticate', 'Bearer realm="forge-core"']);
      return sendError(res, 401, req.headers.authorization ? 'Bad credentials' : 'Requires authentication');
    }
    let body;
    try {
      body = decodeBody(req);
    } catch {
      return sendError(res, 400, 'Problems parsing JSON');
    }
    const base = 'http://' + (req.headers.host || 'localhost');
    if (isMcp) {
      const out = handleMcp({ method, body, base, headers: req.headers });
      return send(res, out.status, JSON_TYPE, out.body, out.headers);
    }
    if (isGql) {
      if (method !== 'POST') return sendError(res, 404, 'Not Found');
      const out = handleGraphql({ body, base });
      return send(res, out.status, JSON_TYPE, out.body, API_HEADERS);
    }
    const ctx = { method, path, segs: splitSegs(path.slice(7)), query: new URLSearchParams(queryText), body, base };
    const out = handleRest(ctx);
    return send(res, out.status, JSON_TYPE, out.body, out.headers ? API_HEADERS.concat(out.headers) : API_HEADERS);
  } catch (e) {
    if (e instanceof ApiError) return sendError(res, e.status, e.message, e.extra);
    return sendError(res, 500, 'Internal error: ' + String((e && e.message) || e));
  }
}

export function startServer() {
  return createHttpServer(dispatch);
}
