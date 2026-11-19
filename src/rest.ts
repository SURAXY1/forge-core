// GitHub REST v3 routing under /api/v3. Handlers return { status, body, headers? }.
import { ApiError, VIEWER, findRepo, needRepo, createRepo, deleteRepo, listRepos, touchRepo, repos } from './store.ts';
import { getCommit, getTree, lookupPath, walkHistory, peel, putObject, parseIdent, flatten } from './gitobj.ts';
import * as ops from './ops.ts';
import * as S from './shapes.ts';

const NOT_FOUND = () => new ApiError(404, 'Not Found');
const DOCS = 'https://docs.github.com/rest';

export function jsonBody(ctx) {
  const raw = ctx.body;
  if (!raw || raw.length === 0) return {};
  let v;
  try {
    v = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'Body should be a JSON object');
  return v;
}

const ok = (status, value, headers) => ({ status, body: JSON.stringify(value), headers });
const NO_CONTENT = { status: 204, body: '' };

function page(ctx, items) {
  const q = ctx.query;
  let per = parseInt(q.get('per_page') || '30', 10);
  if (!(per >= 1)) per = 30;
  if (per > 100) per = 100;
  let pg = parseInt(q.get('page') || '1', 10);
  if (!(pg >= 1)) pg = 1;
  const total = items.length;
  const last = Math.max(1, Math.ceil(total / per));
  const slice = items.slice((pg - 1) * per, pg * per);
  const links = [];
  const mk = (n, rel) => {
    const u = new URLSearchParams(q);
    u.set('page', String(n));
    if (!u.has('per_page')) u.set('per_page', String(per));
    links.push('<' + ctx.base + ctx.path + '?' + u.toString() + '>; rel="' + rel + '"');
  };
  if (pg < last) {
    mk(pg + 1, 'next');
    mk(last, 'last');
  }
  if (pg > 1) {
    mk(pg - 1, 'prev');
    mk(1, 'first');
  }
  return { slice, headers: links.length ? ['Link', links.join(', ')] : undefined };
}

function sortRepos(ctx, list) {
  const sort = ctx.query.get('sort') || 'full_name';
  const dir = ctx.query.get('direction') || (sort === 'full_name' ? 'asc' : 'desc');
  const key = sort === 'created' ? (r) => r.createdAt : sort === 'updated' ? (r) => r.updatedAt : sort === 'pushed' ? (r) => r.pushedAt : (r) => r.fullName.toLowerCase();
  list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id));
  if (dir === 'desc') list.reverse();
  return list;
}

function repoList(ctx, owner) {
  let list = sortRepos(ctx, listRepos(owner));
  const vis = ctx.query.get('visibility') || ctx.query.get('type');
  if (vis === 'public') list = list.filter((r) => !r.private);
  else if (vis === 'private') list = list.filter((r) => r.private);
  const p = page(ctx, list);
  return ok(200, p.slice.map((r) => S.repoJson(ctx.base, r)), p.headers);
}

function makeRepo(ctx, owner) {
  const input = jsonBody(ctx);
  const repo = createRepo(owner, input);
  if (input.auto_init === true) {
    ops.writeFile(repo, 'README.md', { message: 'Initial commit' }, Buffer.from('# ' + repo.name + '\n' + (repo.description ? '\n' + repo.description + '\n' : '')));
  }
  return ok(201, S.repoJson(ctx.base, repo));
}

export function handleRest(ctx) {
  const s = ctx.segs;
  const m = ctx.method;
  const n = s.length;
  if (n === 0) {
    if (m !== 'GET') throw NOT_FOUND();
    const api = ctx.base + '/api/v3';
    return ok(200, {
      current_user_url: api + '/user',
      current_user_repositories_url: api + '/user/repos{?type,page,per_page,sort}',
      repository_url: api + '/repos/{owner}/{repo}',
      user_url: api + '/users/{user}',
      user_repositories_url: api + '/users/{user}/repos{?type,page,per_page,sort}',
      organization_url: api + '/orgs/{org}',
      organization_repositories_url: api + '/orgs/{org}/repos{?type,page,per_page,sort}',
      issues_url: api + '/issues',
      rate_limit_url: api + '/rate_limit',
    });
  }
  switch (s[0]) {
    case 'meta':
      if (n === 1 && m === 'GET') return ok(200, { verifiable_password_authentication: false, installed_version: '3.14.0' });
      break;
    case 'rate_limit':
      if (n === 1 && m === 'GET') {
        const core = { limit: 5000, used: 0, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 };
        return ok(200, { resources: { core, graphql: core, search: core }, rate: core });
      }
      break;
    case 'user':
      if (n === 1 && m === 'GET') return ok(200, S.viewerJson(ctx.base));
      if (n === 2 && s[1] === 'repos') {
        if (m === 'GET') return repoList(ctx, VIEWER.login);
        if (m === 'POST') return makeRepo(ctx, VIEWER.login);
      }
      if (n === 2 && s[1] === 'orgs' && m === 'GET') return ok(200, []);
      break;
    case 'users':
      if (n === 2 && m === 'GET') {
        if (s[1].toLowerCase() === VIEWER.login.toLowerCase()) return ok(200, S.viewerJson(ctx.base));
        if (listRepos(s[1]).length) return ok(200, S.userJson(ctx.base, s[1]));
      }
      if (n === 3 && s[2] === 'repos' && m === 'GET') return repoList(ctx, s[1]);
      break;
    case 'orgs':
      if (n === 3 && s[2] === 'repos') {
        if (m === 'GET') return repoList(ctx, s[1]);
        if (m === 'POST') return makeRepo(ctx, s[1]);
      }
      break;
    case 'repositories':
      if (n === 1 && m === 'GET') {
        const p = page(ctx, [...repos.values()]);
        return ok(200, p.slice.map((r) => S.repoJson(ctx.base, r)), p.headers);
      }
      break;
    case 'repos':
      if (n >= 3) return repoRoute(ctx, needRepo(s[1], s[2]), s, m, n);
      break;
  }
  throw NOT_FOUND();
}

function repoRoute(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 3) {
    if (m === 'GET') {
      if (!repo.json || repo.jsonBase !== base) {
        repo.json = JSON.stringify(S.repoJson(base, repo));
        repo.jsonBase = base;
      }
      return { status: 200, body: repo.json };
    }
    if (m === 'PATCH') {
      const input = jsonBody(ctx);
      if (typeof input.description === 'string' || input.description === null) repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.visibility === 'string') repo.private = input.visibility === 'private';
      if (typeof input.homepage === 'string') repo.homepage = input.homepage;
      if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
      if (typeof input.default_branch === 'string' && input.default_branch !== repo.defaultBranch) {
        if (!repo.refs.has('refs/heads/' + input.default_branch)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
        repo.defaultBranch = input.default_branch;
        repo.fetchCache = null;
      }
      touchRepo(repo);
      return ok(200, S.repoJson(base, repo));
    }
    if (m === 'DELETE') {
      deleteRepo(repo);
      return NO_CONTENT;
    }
    throw NOT_FOUND();
  }
  switch (s[3]) {
    case 'issues':
      return issueRoute(ctx, repo, s, m, n);
    case 'pulls':
      return pullRoute(ctx, repo, s, m, n);
    case 'labels':
      return labelRoute(ctx, repo, s, m, n);
    case 'contents':
      return contentsRoute(ctx, repo, s.slice(4).join('/'), m);
    case 'readme':
      if (m === 'GET') return contentsRoute(ctx, repo, 'README.md', m);
      break;
    case 'branches': {
      if (m !== 'GET') break;
      if (n === 4) {
        const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11)).sort();
        const p = page(ctx, names);
        return ok(200, p.slice.map((name) => S.branchJson(base, repo, name, false)), p.headers);
      }
      const name = s.slice(4).join('/');
      if (!repo.refs.has('refs/heads/' + name)) throw new ApiError(404, 'Branch not found');
      return ok(200, S.branchJson(base, repo, name, true));
    }
    case 'tags': {
      if (m !== 'GET' || n !== 4) break;
      const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
      const p = page(ctx, names);
      return ok(200, p.slice.map((ref) => {
        const sha = peel(repo.objects, repo.refs.get(ref));
        return { name: ref.slice(10), commit: { sha, url: base + '/api/v3/repos/' + repo.fullName + '/commits/' + sha }, node_id: Buffer.from('03:Ref' + ref).toString('base64') };
      }), p.headers);
    }
    case 'commits':
      return commitRoute(ctx, repo, s, m, n);
    case 'git':
      return gitRoute(ctx, repo, s, m, n);
    case 'compare':
      if (m === 'GET' && n >= 5) return compareRoute(ctx, repo, s.slice(4).join('/'));
      break;
  }
  throw NOT_FOUND();
}

// ---- issues
function needItem(repo, raw) {
  const num = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const it = repo.issues.get(num);
  if (!it) throw NOT_FOUND();
  return it;
}

function issueReply(ctx, repo, it, status) {
  if (!it.buf || it.bufBase !== ctx.base) {
    it.buf = Buffer.from(JSON.stringify(S.issueJson(ctx.base, repo, it)));
    it.bufBase = ctx.base;
  }
  return { status, body: it.buf };
}

function filterItems(ctx, list) {
  const q = ctx.query;
  const state = q.get('state') || 'open';
  let out = state === 'all' ? list.slice() : list.filter((it) => it.state === state);
  const labels = q.get('labels');
  if (labels) {
    const want = labels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
    out = out.filter((it) => want.every((w) => it.labels.some((l) => l.name.toLowerCase() === w)));
  }
  const since = q.get('since');
  if (since) out = out.filter((it) => it.updatedAt >= since);
  const sort = q.get('sort') || 'created';
  if (sort === 'updated') out.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
  else if (sort === 'comments') out.sort((a, b) => a.comments.length - b.comments.length || a.number - b.number);
  else out.sort((a, b) => a.number - b.number);
  if ((q.get('direction') || 'desc') !== 'asc') out.reverse();
  return out;
}

function issueRoute(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 4) {
    if (m === 'POST') return issueReply(ctx, repo, ops.createIssue(repo, jsonBody(ctx)), 201);
    if (m === 'GET') {
      const p = page(ctx, filterItems(ctx, [...repo.issues.values()]));
      return ok(200, p.slice.map((it) => S.issueJson(base, repo, it)), p.headers);
    }
    throw NOT_FOUND();
  }
  if (s[4] === 'comments') {
    if (n === 5 && m === 'GET') {
      const all = [];
      for (const it of repo.issues.values()) for (const c of it.comments) all.push(c);
      all.sort((a, b) => a.id - b.id);
      const p = page(ctx, all);
      return ok(200, p.slice.map((c) => S.commentJson(base, repo, c)), p.headers);
    }
    if (n === 6) {
      const id = Number(s[5]);
      for (const it of repo.issues.values()) {
        const at = it.comments.findIndex((c) => c.id === id);
        if (at < 0) continue;
        const c = it.comments[at];
        if (m === 'GET') return ok(200, S.commentJson(base, repo, c));
        if (m === 'PATCH') {
          const input = jsonBody(ctx);
          if (typeof input.body !== 'string' || input.body === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
          c.body = input.body;
          ops.touchItem(it);
          return ok(200, S.commentJson(base, repo, c));
        }
        if (m === 'DELETE') {
          it.comments.splice(at, 1);
          ops.touchItem(it);
          return NO_CONTENT;
        }
      }
    }
    throw NOT_FOUND();
  }
  const it = needItem(repo, s[4]);
  if (n === 5) {
    if (m === 'GET') return issueReply(ctx, repo, it, 200);
    if (m === 'PATCH') return issueReply(ctx, repo, ops.updateItem(repo, it, jsonBody(ctx)), 200);
    throw NOT_FOUND();
  }
  if (s[5] === 'comments' && n === 6) {
    if (m === 'GET') {
      const p = page(ctx, it.comments);
      return ok(200, p.slice.map((c) => S.commentJson(base, repo, c)), p.headers);
    }
    if (m === 'POST') return ok(201, S.commentJson(base, repo, ops.addComment(repo, it, jsonBody(ctx).body)));
  }
  if (s[5] === 'labels') {
    if (n === 6 && m === 'GET') return ok(200, it.labels.map((l) => S.labelJson(base, repo, l)));
    if (n === 6 && (m === 'POST' || m === 'PUT')) {
      const input = ctx.body && ctx.body.length ? JSON.parse(ctx.body.toString('utf8')) : {};
      const names = Array.isArray(input) ? input : input.labels;
      const cur = m === 'PUT' ? [] : it.labels.map((l) => l.name);
      ops.updateItem(repo, it, { labels: [...cur, ...(Array.isArray(names) ? names : [])] });
      return ok(200, it.labels.map((l) => S.labelJson(base, repo, l)));
    }
    if (m === 'DELETE') {
      if (n === 6) it.labels = [];
      else {
        const want = s.slice(6).join('/').toLowerCase();
        if (!it.labels.some((l) => l.name.toLowerCase() === want)) throw new ApiError(404, 'Label does not exist');
        it.labels = it.labels.filter((l) => l.name.toLowerCase() !== want);
      }
      ops.touchItem(it);
      return n === 6 ? NO_CONTENT : ok(200, it.labels.map((l) => S.labelJson(base, repo, l)));
    }
  }
  throw NOT_FOUND();
}

function labelRoute(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 4) {
    if (m === 'GET') {
      const p = page(ctx, [...repo.labels.values()]);
      return ok(200, p.slice.map((l) => S.labelJson(base, repo, l)), p.headers);
    }
    if (m === 'POST') return ok(201, S.labelJson(base, repo, ops.createLabel(repo, jsonBody(ctx))));
    throw NOT_FOUND();
  }
  const key = s.slice(4).join('/').toLowerCase();
  const label = repo.labels.get(key);
  if (!label) throw NOT_FOUND();
  if (m === 'GET') return ok(200, S.labelJson(base, repo, label));
  if (m === 'PATCH') {
    const input = jsonBody(ctx);
    if (typeof input.color === 'string') label.color = input.color.replace(/^#/, '');
    if (typeof input.description === 'string') label.description = input.description;
    if (typeof input.new_name === 'string' && input.new_name !== '') {
      repo.labels.delete(key);
      label.name = input.new_name;
      repo.labels.set(label.name.toLowerCase(), label);
    }
    for (const it of repo.issues.values()) if (it.labels.includes(label)) ops.touchItem(it);
    return ok(200, S.labelJson(base, repo, label));
  }
  if (m === 'DELETE') {
    repo.labels.delete(key);
    for (const it of repo.issues.values()) {
      if (it.labels.includes(label)) {
        it.labels = it.labels.filter((l) => l !== label);
        ops.touchItem(it);
      }
    }
    return NO_CONTENT;
  }
  throw NOT_FOUND();
}

// ---- pull requests
function pullRoute(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 4) {
    if (m === 'POST') return ok(201, S.pullJson(base, repo, ops.createPull(repo, jsonBody(ctx)), true));
    if (m === 'GET') {
      let list = filterItems(ctx, repo.pullList);
      const head = ctx.query.get('head');
      if (head) list = list.filter((it) => it.pull.head === head.slice(head.indexOf(':') + 1));
      const b = ctx.query.get('base');
      if (b) list = list.filter((it) => it.pull.base === b);
      const p = page(ctx, list);
      return ok(200, p.slice.map((it) => S.pullJson(base, repo, it, false)), p.headers);
    }
    throw NOT_FOUND();
  }
  const it = needItem(repo, s[4]);
  if (!it.pull) throw NOT_FOUND();
  if (n === 5) {
    if (m === 'GET') return ok(200, S.pullJson(base, repo, it, true));
    if (m === 'PATCH') {
      const input = jsonBody(ctx);
      if (typeof input.base === 'string' && input.base !== it.pull.base) {
        if (!repo.refs.has('refs/heads/' + input.base)) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
        it.pull.base = input.base;
      }
      ops.updateItem(repo, it, input);
      return ok(200, S.pullJson(base, repo, it, true));
    }
    throw NOT_FOUND();
  }
  if (n === 6 && s[5] === 'files' && m === 'GET') {
    const api = base + '/api/v3/repos/' + repo.fullName;
    const p = page(ctx, ops.pullFiles(repo, it));
    return ok(200, p.slice.map((f) => ({
      ...f,
      blob_url: base + '/' + repo.fullName + '/blob/' + it.pull.headSha + '/' + f.filename,
      raw_url: base + '/' + repo.fullName + '/raw/' + it.pull.headSha + '/' + f.filename,
      contents_url: api + '/contents/' + f.filename + '?ref=' + it.pull.headSha,
    })), p.headers);
  }
  if (n === 6 && s[5] === 'commits' && m === 'GET') {
    const p0 = ops.pullTips(repo, it);
    const stop = new Set(walkHistory(repo.objects, p0.merged ? getCommit(repo.objects, p0.mergeSha).parents[0] : p0.baseSha));
    const list = walkHistory(repo.objects, p0.headSha).filter((sha) => !stop.has(sha)).reverse();
    const p = page(ctx, list);
    return ok(200, p.slice.map((sha) => S.commitJson(base, repo, sha)), p.headers);
  }
  if (n === 6 && s[5] === 'merge') {
    if (m === 'GET') {
      if (it.pull.merged) return NO_CONTENT;
      throw NOT_FOUND();
    }
    if (m === 'PUT') {
      const sha = ops.mergePull(repo, it, jsonBody(ctx));
      return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  throw NOT_FOUND();
}

// ---- commits, refs, raw git data
function commitRoute(ctx, repo, s, m, n) {
  if (m !== 'GET') throw NOT_FOUND();
  const base = ctx.base;
  if (n === 4) {
    const rev = ctx.query.get('sha');
    const tip = ops.resolveCommit(repo, rev || '');
    if (!tip) {
      if (!rev && repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
      throw NOT_FOUND();
    }
    let list = walkHistory(repo.objects, tip);
    const path = ctx.query.get('path');
    if (path) {
      const at = (sha) => {
        const e = lookupPath(repo.objects, getCommit(repo.objects, sha).tree, path.replace(/^\/+|\/+$/g, ''));
        return e ? e.oid : '';
      };
      list = list.filter((sha) => {
        const c = getCommit(repo.objects, sha);
        const mine = at(sha);
        if (c.parents.length === 0) return mine !== '';
        return c.parents.every((p) => at(p) !== mine);
      });
    }
    const p = page(ctx, list);
    return ok(200, p.slice.map((sha) => S.commitJson(base, repo, sha)), p.headers);
  }
  const sha = ops.resolveCommit(repo, s.slice(4).join('/'));
  if (!sha || !getCommit(repo.objects, sha)) throw new ApiError(422, 'No commit found for SHA: ' + s.slice(4).join('/'));
  const out = S.commitJson(base, repo, sha);
  const c = getCommit(repo.objects, sha);
  const before = c.parents.length ? flatten(repo.objects, getCommit(repo.objects, c.parents[0]).tree) : new Map();
  const after = flatten(repo.objects, c.tree);
  const files = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(path);
    const y = after.get(path);
    if (x && y && x.oid === y.oid) continue;
    files.push({ sha: y ? y.oid : x.oid, filename: path, status: !x ? 'added' : !y ? 'removed' : 'modified', additions: y ? 1 : 0, deletions: x ? 1 : 0, changes: (y ? 1 : 0) + (x ? 1 : 0) });
  }
  out.files = files;
  out.stats = { additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0), total: files.reduce((a, f) => a + f.changes, 0) };
  return ok(200, out);
}

function compareRoute(ctx, repo, spec) {
  const cut = spec.indexOf('...');
  if (cut < 0) throw NOT_FOUND();
  const a = ops.resolveCommit(repo, spec.slice(0, cut));
  const b = ops.resolveCommit(repo, spec.slice(cut + 3));
  if (!a || !b) throw NOT_FOUND();
  const behind = new Set(walkHistory(repo.objects, a));
  const aheadList = walkHistory(repo.objects, b).filter((sha) => !behind.has(sha)).reverse();
  const mine = new Set(walkHistory(repo.objects, b));
  let behindBy = 0;
  for (const sha of behind) if (!mine.has(sha)) behindBy++;
  const status = aheadList.length && behindBy ? 'diverged' : aheadList.length ? 'ahead' : behindBy ? 'behind' : 'identical';
  return ok(200, { status, ahead_by: aheadList.length, behind_by: behindBy, total_commits: aheadList.length, base_commit: S.commitJson(ctx.base, repo, a), commits: aheadList.map((sha) => S.commitJson(ctx.base, repo, sha)), files: [] });
}

function gitRoute(ctx, repo, s, m, n) {
  const base = ctx.base;
  const api = base + '/api/v3/repos/' + repo.fullName;
  const kind = s[4];
  if (kind === 'refs' && n === 5 && m === 'POST') {
    const input = jsonBody(ctx);
    if (typeof input.ref !== 'string' || !/^refs\/[^/]+\/.+/.test(input.ref)) throw new ApiError(422, 'Reference name must start with refs/ and contain at least two slashes');
    if (typeof input.sha !== 'string' || !repo.objects.has(input.sha)) throw new ApiError(422, 'Object does not exist');
    if (repo.refs.has(input.ref)) throw new ApiError(422, 'Reference already exists');
    ops.setRef(repo, input.ref, input.sha);
    return ok(201, S.refJson(base, repo, input.ref));
  }
  if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
    const tail = s.slice(5).join('/');
    const ref = 'refs/' + tail;
    if (m === 'GET') {
      if (repo.refs.has(ref) && kind !== 'matching-refs') return ok(200, S.refJson(base, repo, ref));
      const hits = [...repo.refs.keys()].filter((r) => r.startsWith(ref)).sort();
      if (kind === 'matching-refs' || (kind === 'refs' && (hits.length > 0 || tail === ''))) {
        if (kind === 'refs' && hits.length === 0 && tail !== '') throw NOT_FOUND();
        return ok(200, hits.map((r) => S.refJson(base, repo, r)));
      }
      throw NOT_FOUND();
    }
    if (!repo.refs.has(ref)) throw new ApiError(422, 'Reference does not exist');
    if (m === 'PATCH') {
      const input = jsonBody(ctx);
      if (typeof input.sha !== 'string' || !repo.objects.has(input.sha)) throw new ApiError(422, 'Object does not exist');
      ops.setRef(repo, ref, input.sha);
      return ok(200, S.refJson(base, repo, ref));
    }
    if (m === 'DELETE') {
      ops.setRef(repo, ref, null);
      return NO_CONTENT;
    }
    throw NOT_FOUND();
  }
  if (kind === 'commits' && n === 6 && m === 'GET') {
    const c = getCommit(repo.objects, s[5]);
    if (!c) throw NOT_FOUND();
    const j = S.commitJson(base, repo, s[5]);
    return ok(200, { sha: s[5], node_id: j.node_id, url: api + '/git/commits/' + s[5], html_url: j.html_url, author: j.commit.author, committer: j.commit.committer, tree: j.commit.tree, message: c.message, parents: j.parents, verification: j.commit.verification });
  }
  if (kind === 'trees' && n === 6 && m === 'GET') {
    let oid = s[5];
    const asCommit = ops.resolveCommit(repo, oid);
    if (asCommit && getCommit(repo.objects, asCommit)) oid = getCommit(repo.objects, asCommit).tree;
    if (!getTree(repo.objects, oid)) throw NOT_FOUND();
    const recursive = ctx.query.has('recursive');
    const out = [];
    const walk = (tree, prefix) => {
      for (const e of getTree(repo.objects, tree) || []) {
        const isTree = e.mode === '40000';
        const item = { path: prefix + e.name, mode: isTree ? '040000' : e.mode, type: isTree ? 'tree' : e.mode === '160000' ? 'commit' : 'blob', sha: e.oid };
        if (!isTree && repo.objects.has(e.oid)) item.size = repo.objects.get(e.oid).data.length;
        item.url = api + '/git/' + (isTree ? 'trees' : 'blobs') + '/' + e.oid;
        out.push(item);
        if (isTree && recursive) walk(e.oid, prefix + e.name + '/');
      }
    };
    walk(oid, '');
    return ok(200, { sha: oid, url: api + '/git/trees/' + oid, tree: out, truncated: false });
  }
  if (kind === 'blobs') {
    if (n === 6 && m === 'GET') {
      const o = repo.objects.get(s[5]);
      if (!o || o.type !== 'blob') throw NOT_FOUND();
      return ok(200, { sha: s[5], node_id: Buffer.from('04:Blob' + s[5]).toString('base64'), size: o.data.length, url: api + '/git/blobs/' + s[5], content: o.data.toString('base64'), encoding: 'base64' });
    }
    if (n === 5 && m === 'POST') {
      const input = jsonBody(ctx);
      if (typeof input.content !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
      const sha = putObject(repo.objects, 'blob', Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8'));
      return ok(201, { sha, url: api + '/git/blobs/' + sha });
    }
  }
  if (kind === 'tags' && n === 6 && m === 'GET') {
    const o = repo.objects.get(s[5]);
    if (!o || o.type !== 'tag') throw NOT_FOUND();
    const text = o.data.toString('utf8');
    const cut = text.indexOf('\n\n');
    const head = cut < 0 ? text : text.slice(0, cut);
    const field = (k) => (new RegExp('^' + k + ' (.*)$', 'm').exec(head) || [])[1] || '';
    const who = parseIdent(field('tagger'));
    return ok(200, { sha: s[5], node_id: Buffer.from('03:Tag' + s[5]).toString('base64'), url: api + '/git/tags/' + s[5], tag: field('tag'), message: cut < 0 ? '' : text.slice(cut + 2), tagger: { name: who.name, email: who.email, date: who.date }, object: { sha: field('object'), type: field('type'), url: api + '/git/' + field('type') + 's/' + field('object') } });
  }
  throw NOT_FOUND();
}

// ---- contents
function contentsRoute(ctx, repo, rawPath, m) {
  const base = ctx.base;
  const api = base + '/api/v3/repos/' + repo.fullName;
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  const fileJson = (p, oid, refName, withContent) => {
    const o = repo.objects.get(oid);
    const name = p.slice(p.lastIndexOf('/') + 1);
    const self = api + '/contents/' + p.split('/').map(encodeURIComponent).join('/') + (refName ? '?ref=' + encodeURIComponent(refName) : '');
    const html = base + '/' + repo.fullName + '/blob/' + (refName || repo.defaultBranch) + '/' + p;
    const out = {
      name,
      path: p,
      sha: oid,
      size: o ? o.data.length : 0,
      url: self,
      html_url: html,
      git_url: api + '/git/blobs/' + oid,
      download_url: base + '/' + repo.fullName + '/raw/' + (refName || repo.defaultBranch) + '/' + p,
      type: 'file',
    };
    if (withContent) {
      out.content = o ? o.data.toString('base64') : '';
      out.encoding = 'base64';
    }
    out._links = { self, git: out.git_url, html };
    return out;
  };
  if (m === 'GET') {
    const refName = ctx.query.get('ref') || '';
    const commit = ops.resolveCommit(repo, refName);
    if (!commit) {
      if (repo.refs.size === 0 && !refName) throw new ApiError(404, 'This repository is empty.');
      throw new ApiError(404, refName ? 'No commit found for the ref ' + refName : 'Not Found');
    }
    const tree = getCommit(repo.objects, commit).tree;
    const hit = lookupPath(repo.objects, tree, path);
    if (!hit) throw NOT_FOUND();
    if (hit.mode !== '40000') return ok(200, fileJson(path, hit.oid, refName, true));
    const entries = getTree(repo.objects, hit.oid) || [];
    return ok(200, entries.map((e) => {
      const p = path ? path + '/' + e.name : e.name;
      if (e.mode !== '40000') return fileJson(p, e.oid, refName, false);
      const self = api + '/contents/' + p.split('/').map(encodeURIComponent).join('/') + (refName ? '?ref=' + encodeURIComponent(refName) : '');
      const html = base + '/' + repo.fullName + '/tree/' + (refName || repo.defaultBranch) + '/' + p;
      return { name: e.name, path: p, sha: e.oid, size: 0, url: self, html_url: html, git_url: api + '/git/trees/' + e.oid, download_url: null, type: 'dir', _links: { self, git: api + '/git/trees/' + e.oid, html } };
    }));
  }
  if (m === 'PUT') {
    const input = jsonBody(ctx);
    if (typeof input.content !== 'string') throw new ApiError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
    const res = ops.writeFile(repo, path, input, Buffer.from(input.content, 'base64'));
    const branch = ops.branchName(input.branch) || repo.defaultBranch;
    const cj = S.commitJson(base, repo, res.commit);
    return ok(res.created ? 201 : 200, { content: fileJson(res.path, res.blob, branch, true), commit: { sha: res.commit, node_id: cj.node_id, url: cj.commit.url, html_url: cj.html_url, author: cj.commit.author, committer: cj.commit.committer, tree: cj.commit.tree, message: cj.commit.message, parents: cj.parents, verification: cj.commit.verification } });
  }
  if (m === 'DELETE') {
    const input = jsonBody(ctx);
    if (input.sha === undefined && ctx.query.get('sha')) input.sha = ctx.query.get('sha');
    if (input.message === undefined && ctx.query.get('message')) input.message = ctx.query.get('message');
    if (input.branch === undefined && ctx.query.get('branch')) input.branch = ctx.query.get('branch');
    const res = ops.writeFile(repo, path, input, null);
    const cj = S.commitJson(base, repo, res.commit);
    return ok(200, { content: null, commit: { sha: res.commit, node_id: cj.node_id, url: cj.commit.url, html_url: cj.html_url, author: cj.commit.author, committer: cj.commit.committer, tree: cj.commit.tree, message: cj.commit.message, parents: cj.parents, verification: cj.commit.verification } });
  }
  throw NOT_FOUND();
}
