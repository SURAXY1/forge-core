// In-memory state: the token owner, repositories, and the id counters shared by every API surface.
import { ensureEmptyTree } from './gitobj.ts';

export const VIEWER = {
  login: process.env.FORGE_VIEWER_LOGIN || 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

export const repos = new Map(); // "owner/name" (lower case) -> repo
export const nodes = new Map(); // global node id -> { kind, repo, item }
let nextRepoId = 5000;
let nextItemId = 900000;
let clock = Date.now();

export function nowIso() {
  // Strictly increasing timestamps keep "created" ordering total even inside one millisecond.
  const t = Date.now();
  clock = t > clock ? t : clock + 1;
  return new Date(clock).toISOString();
}

export function newId() {
  return nextItemId++;
}

export function nodeId(kind, n) {
  return Buffer.from('0' + kind.length + ':' + kind + n).toString('base64').replace(/=+$/, '');
}

export function repoKey(owner, name) {
  return (owner + '/' + name).toLowerCase();
}

export function findRepo(owner, name) {
  return repos.get(repoKey(owner, name)) || null;
}

export function needRepo(owner, name) {
  const r = repos.get(repoKey(owner, name));
  if (!r) throw new ApiError(404, 'Not Found');
  return r;
}

const NAME_OK = /^[A-Za-z0-9._-]{1,100}$/;

export function createRepo(owner, input) {
  const name = input && input.name;
  if (typeof name !== 'string' || !NAME_OK.test(name) || name === '.' || name === '..') {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is missing or invalid' }]);
  }
  const key = repoKey(owner, name);
  if (repos.has(key)) {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  const at = nowIso();
  const id = nextRepoId++;
  const repo = {
    id,
    nodeId: nodeId('Repository', id),
    owner,
    name,
    fullName: owner + '/' + name,
    description: typeof input.description === 'string' ? input.description : null,
    private: input.private === true,
    homepage: typeof input.homepage === 'string' ? input.homepage : null,
    hasIssues: input.has_issues !== false,
    defaultBranch: 'main',
    createdAt: at,
    updatedAt: at,
    pushedAt: at,
    objects: new Map(),
    refs: new Map(),
    nextNumber: 1,
    issues: new Map(), // number -> issue (pull requests carry .pull)
    issueList: [], // issues only, creation order
    pullList: [], // pull requests only, creation order
    labels: new Map(), // lower-case name -> label
    json: null,
  };
  ensureEmptyTree(repo.objects);
  repos.set(key, repo);
  nodes.set(repo.nodeId, { kind: 'Repository', repo, item: repo });
  return repo;
}

export function deleteRepo(repo) {
  repos.delete(repoKey(repo.owner, repo.name));
  nodes.delete(repo.nodeId);
  for (const it of repo.issues.values()) {
    nodes.delete(it.nodeId);
    for (const c of it.comments) nodes.delete(c.nodeId);
  }
}

export function touchRepo(repo) {
  repo.updatedAt = nowIso();
  repo.json = null;
}

export function listRepos(owner) {
  const out = [];
  const want = owner.toLowerCase();
  for (const r of repos.values()) if (r.owner.toLowerCase() === want) out.push(r);
  return out;
}

export function headOid(repo) {
  return repo.refs.get('refs/heads/' + repo.defaultBranch) || null;
}

// The branch HEAD names: the default branch when it exists, else the only/first branch pushed.
export function settleDefaultBranch(repo) {
  if (repo.refs.has('refs/heads/' + repo.defaultBranch)) return;
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) {
      if (ref === 'refs/heads/main' || ref === 'refs/heads/master') {
        repo.defaultBranch = ref.slice(11);
        repo.json = null;
        return;
      }
    }
  }
}
