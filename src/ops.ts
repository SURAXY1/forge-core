// Domain operations shared by REST, GraphQL and MCP: refs, file contents, issues, pull requests, merges.
import { ApiError, VIEWER, nowIso, newId, nodeId, nodes, touchRepo, settleDefaultBranch } from './store.ts';
import { putObject, getCommit, getTree, lookupPath, editTree, makeCommit, ensureEmptyTree, flatten, treeFromFlat, mergeBase, isAncestor, peel } from './gitobj.ts';

export function ident() {
  return VIEWER.name + ' <' + VIEWER.email + '> ' + Math.floor(Date.now() / 1000) + ' +0000';
}

export function setRef(repo, ref, oid) {
  if (oid === null) repo.refs.delete(ref);
  else repo.refs.set(ref, oid);
  repo.fetchCache = null;
  settleDefaultBranch(repo);
  repo.pushedAt = nowIso();
  touchRepo(repo);
}

// Resolve a branch name, tag name, full ref or commit id to a commit id.
export function resolveCommit(repo, rev) {
  if (!rev) rev = repo.defaultBranch;
  const tries = [rev.startsWith('refs/') ? rev : null, 'refs/heads/' + rev, 'refs/tags/' + rev, rev.startsWith('heads/') || rev.startsWith('tags/') ? 'refs/' + rev : null];
  for (const t of tries) {
    if (t && repo.refs.has(t)) return peel(repo.objects, repo.refs.get(t));
  }
  if (/^[0-9a-f]{40}$/.test(rev) && repo.objects.has(rev)) return peel(repo.objects, rev);
  if (/^[0-9a-f]{7,39}$/.test(rev)) {
    for (const [oid, o] of repo.objects) if (o.type === 'commit' && oid.startsWith(rev)) return oid;
  }
  return null;
}

export function branchName(input) {
  if (typeof input !== 'string') return '';
  if (input.startsWith('refs/heads/')) return input.slice(11);
  return input;
}

function cleanPath(path) {
  const parts = String(path || '').split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..')) throw new ApiError(422, 'path contains a malformed path component');
  return parts;
}

// Create, update or delete one file as a new commit on a branch. content === null deletes.
export function writeFile(repo, path, input, content) {
  const parts = cleanPath(path);
  if (parts.length === 0) throw new ApiError(422, 'path cannot be empty');
  if (!input || typeof input.message !== 'string' || input.message === '') throw new ApiError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const branch = branchName(input.branch) || repo.defaultBranch;
  const ref = 'refs/heads/' + branch;
  let parent = repo.refs.get(ref) || null;
  if (!parent && repo.refs.size > 0 && branch !== repo.defaultBranch) {
    // Writing to a branch that does not exist yet: grow it from the default branch.
    parent = repo.refs.get('refs/heads/' + repo.defaultBranch) || null;
    if (!parent) throw new ApiError(404, 'Branch ' + branch + ' not found');
  }
  const objects = repo.objects;
  const parentTree = parent ? getCommit(objects, parent).tree : null;
  const existing = parentTree ? lookupPath(objects, parentTree, parts.join('/')) : null;
  if (existing && existing.mode === '40000') throw new ApiError(422, 'path is a directory');
  if (content === null) {
    if (!existing) throw new ApiError(404, 'Not Found');
    if (typeof input.sha !== 'string' || input.sha === '') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (input.sha !== existing.oid) throw new ApiError(409, parts.join('/') + ' does not match ' + input.sha);
  } else if (existing) {
    if (typeof input.sha !== 'string' || input.sha === '') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (input.sha !== existing.oid) throw new ApiError(409, parts.join('/') + ' does not match ' + input.sha);
  } else if (typeof input.sha === 'string' && input.sha !== '') {
    throw new ApiError(409, parts.join('/') + ' does not match ' + input.sha);
  }
  const blob = content === null ? null : putObject(objects, 'blob', content);
  let tree = editTree(objects, parentTree, parts, blob);
  if (tree === null) tree = ensureEmptyTree(objects);
  const who = (p) => (p && typeof p.name === 'string' && typeof p.email === 'string' ? p.name + ' <' + p.email + '> ' + Math.floor(Date.now() / 1000) + ' +0000' : null);
  const committer = who(input.committer) || ident();
  const author = who(input.author) || committer;
  const commit = makeCommit(objects, { tree, parents: parent ? [parent] : [], author, committer, message: input.message });
  setRef(repo, ref, commit);
  return { commit, blob, created: !existing, path: parts.join('/') };
}

// ---- labels, issues, comments
export function createLabel(repo, input) {
  const name = input && input.name;
  if (typeof name !== 'string' || name.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  const key = name.toLowerCase();
  if (repo.labels.has(key)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  const id = newId();
  const label = {
    id,
    nodeId: nodeId('Label', id),
    name,
    color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
    description: typeof input.description === 'string' ? input.description : null,
  };
  repo.labels.set(key, label);
  return label;
}

function labelsFor(repo, names) {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const out = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw : raw && typeof raw.name === 'string' ? raw.name : null;
    const label = name === null ? null : repo.labels.get(name.toLowerCase());
    if (!label) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'name', value: name, message: 'label ' + JSON.stringify(name) + ' does not exist' }]);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function newItem(repo, kind, title, body) {
  const id = newId();
  const at = nowIso();
  const item = {
    id,
    nodeId: nodeId(kind, id),
    number: repo.nextNumber++,
    title,
    body: typeof body === 'string' ? body : '',
    state: 'open',
    stateReason: null,
    labels: [],
    comments: [],
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    pull: null,
    json: null,
    buf: null,
  };
  repo.issues.set(item.number, item);
  nodes.set(item.nodeId, { kind, repo, item });
  return item;
}

export function createIssue(repo, input) {
  if (!input || typeof input.title !== 'string' || input.title.trim() === '') {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  }
  const labels = labelsFor(repo, input.labels);
  const item = newItem(repo, 'Issue', input.title, input.body);
  item.labels = labels;
  repo.issueList.push(item);
  return item;
}

export function touchItem(item) {
  item.updatedAt = nowIso();
  item.json = null;
  item.buf = null;
}

export function setState(item, state, reason) {
  if (state !== 'open' && state !== 'closed') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
  if (item.pull && item.pull.merged && state === 'open') throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'a merged pull request cannot be reopened' }]);
  if (item.state !== state) {
    item.state = state;
    item.closedAt = state === 'closed' ? nowIso() : null;
    item.stateReason = state === 'closed' ? reason || 'completed' : item.closedAt === null && reason ? reason : null;
    if (item.pull && state === 'closed') freezePull(null, item);
  }
  touchItem(item);
}

export function updateItem(repo, item, input) {
  if (!input || typeof input !== 'object') throw new ApiError(422, 'Invalid request.');
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'title' }]);
    item.title = input.title;
  }
  if (input.body !== undefined) item.body = typeof input.body === 'string' ? input.body : '';
  if (input.labels !== undefined && !item.pull) item.labels = labelsFor(repo, input.labels);
  if (input.state !== undefined) setState(item, input.state, typeof input.state_reason === 'string' ? input.state_reason : null);
  touchItem(item);
  return item;
}

export function addComment(repo, item, body) {
  if (typeof body !== 'string' || body === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
  const id = newId();
  const at = nowIso();
  const c = { id, nodeId: nodeId('IssueComment', id), body, createdAt: at, updatedAt: at, issue: item };
  item.comments.push(c);
  nodes.set(c.nodeId, { kind: 'IssueComment', repo, item: c });
  touchItem(item);
  return c;
}

// ---- pull requests
function headBranch(repo, head) {
  if (typeof head !== 'string') return '';
  const colon = head.indexOf(':');
  if (colon >= 0) {
    if (head.slice(0, colon).toLowerCase() !== repo.owner.toLowerCase()) return '';
    head = head.slice(colon + 1);
  }
  return branchName(head);
}

export function createPull(repo, input) {
  if (!input || typeof input !== 'object') throw new ApiError(422, 'Invalid request.');
  if (typeof input.title !== 'string' || input.title.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }]);
  const head = headBranch(repo, input.head);
  const base = branchName(input.base);
  if (head === '' || !repo.refs.has('refs/heads/' + head)) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  if (base === '' || !repo.refs.has('refs/heads/' + base)) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
  if (head === base) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'head and base must be different branches' }]);
  for (const p of repo.pullList) {
    if (p.state === 'open' && p.pull.head === head && p.pull.base === base) {
      throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for ' + repo.owner + ':' + head + '.' }]);
    }
  }
  const headSha = repo.refs.get('refs/heads/' + head);
  const baseSha = repo.refs.get('refs/heads/' + base);
  if (headSha === baseSha || isAncestor(repo.objects, headSha, baseSha)) {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'No commits between ' + base + ' and ' + head }]);
  }
  const item = newItem(repo, 'PullRequest', input.title, input.body);
  item.pull = { head, base, headSha, baseSha, merged: false, mergedAt: null, mergeSha: null, draft: input.draft === true, frozen: false };
  repo.pullList.push(item);
  return item;
}

// Live head/base commit ids while the pull request is open; frozen once closed or merged.
export function pullTips(repo, item) {
  const p = item.pull;
  if (!p.frozen) {
    const h = repo.refs.get('refs/heads/' + p.head);
    const b = repo.refs.get('refs/heads/' + p.base);
    if (h) p.headSha = h;
    if (b) p.baseSha = b;
  }
  return p;
}

function freezePull(repo, item) {
  item.pull.frozen = true;
}

// Three-way merge at path granularity. Returns { tree } or { conflicts: [paths] }.
export function mergeTrees(repo, baseSha, headSha) {
  const objects = repo.objects;
  const fork = mergeBase(objects, baseSha, headSha);
  const m = fork ? flatten(objects, getCommit(objects, fork).tree) : new Map();
  const b = flatten(objects, getCommit(objects, baseSha).tree);
  const h = flatten(objects, getCommit(objects, headSha).tree);
  const out = new Map();
  const conflicts = [];
  const paths = new Set([...b.keys(), ...h.keys(), ...m.keys()]);
  for (const path of paths) {
    const mo = m.get(path);
    const bo = b.get(path);
    const ho = h.get(path);
    const mk = mo ? mo.oid + mo.mode : '';
    const bk = bo ? bo.oid + bo.mode : '';
    const hk = ho ? ho.oid + ho.mode : '';
    let pick;
    if (bk === hk || mk === hk) pick = bo;
    else if (mk === bk) pick = ho;
    else {
      conflicts.push(path);
      continue;
    }
    if (pick) out.set(path, pick);
  }
  if (conflicts.length) return { conflicts, fork };
  return { tree: out.size ? treeFromFlat(objects, out) : ensureEmptyTree(objects), fork };
}

export function mergeable(repo, item) {
  if (item.pull.merged || item.state !== 'open') return null;
  const p = pullTips(repo, item);
  const key = p.headSha + p.baseSha;
  if (p.mergeKey !== key) {
    p.mergeKey = key;
    p.mergeOk = !mergeTrees(repo, p.baseSha, p.headSha).conflicts;
  }
  return p.mergeOk;
}

export function mergePull(repo, item, input) {
  input = input || {};
  const p = pullTips(repo, item);
  if (p.merged) throw new ApiError(405, 'Pull Request is not mergeable');
  if (item.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
  const method = typeof input.merge_method === 'string' ? input.merge_method.toLowerCase() : 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new ApiError(422, 'Invalid request.\n\nmerge_method is not a member of ["merge", "squash", "rebase"].');
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== p.headSha) throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  const objects = repo.objects;
  const baseRef = 'refs/heads/' + p.base;
  if (!repo.refs.has(baseRef) || !repo.refs.has('refs/heads/' + p.head)) throw new ApiError(405, 'Pull Request is not mergeable');
  const res = mergeTrees(repo, p.baseSha, p.headSha);
  if (res.conflicts) throw new ApiError(405, 'Pull Request is not mergeable');
  const title = typeof input.commit_title === 'string' && input.commit_title !== '' ? input.commit_title : method === 'merge' ? 'Merge pull request #' + item.number + ' from ' + repo.owner + '/' + p.head : item.title + ' (#' + item.number + ')';
  const extra = typeof input.commit_message === 'string' && input.commit_message !== '' ? input.commit_message : method === 'merge' ? item.title : '';
  const message = extra ? title + '\n\n' + extra : title;
  const who = ident();
  const sha = makeCommit(objects, { tree: res.tree, parents: method === 'merge' ? [p.baseSha, p.headSha] : [p.baseSha], author: who, committer: who, message });
  p.merged = true;
  p.mergedAt = nowIso();
  p.mergeSha = sha;
  p.frozen = true;
  item.state = 'closed';
  item.closedAt = p.mergedAt;
  setRef(repo, baseRef, sha);
  touchItem(item);
  return sha;
}

function lineCounts(objects, oldOid, newOid) {
  const lines = (oid) => {
    if (!oid) return [];
    const o = objects.get(oid);
    if (!o) return [];
    const text = o.data.toString('utf8');
    if (text === '') return [];
    const arr = text.split('\n');
    if (arr[arr.length - 1] === '') arr.pop();
    return arr;
  };
  const a = lines(oldOid);
  const b = lines(newOid);
  const bag = new Map();
  for (const l of a) bag.set(l, (bag.get(l) || 0) + 1);
  let additions = 0;
  for (const l of b) {
    const n = bag.get(l) || 0;
    if (n > 0) bag.set(l, n - 1);
    else additions++;
  }
  let deletions = 0;
  for (const n of bag.values()) deletions += n;
  return { additions, deletions };
}

// Files a pull request changes relative to where it forked from its base.
export function pullFiles(repo, item) {
  const objects = repo.objects;
  const p = pullTips(repo, item);
  let from;
  let to = p.headSha;
  if (p.merged && p.mergeSha) {
    const mc = getCommit(objects, p.mergeSha);
    from = mc.parents[0] || null;
    to = p.mergeSha;
  } else from = mergeBase(objects, p.baseSha, p.headSha);
  const a = from ? flatten(objects, getCommit(objects, from).tree) : new Map();
  const b = flatten(objects, getCommit(objects, to).tree);
  const out = [];
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const path of paths) {
    const x = a.get(path);
    const y = b.get(path);
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    const counts = lineCounts(objects, x ? x.oid : null, y ? y.oid : null);
    if (y && counts.additions === 0 && counts.deletions === 0) counts.additions = 1;
    out.push({
      sha: y ? y.oid : x.oid,
      filename: path,
      status: !x ? 'added' : !y ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}
