// GraphQL schema table: every type, its fields, argument names and resolvers over the shared store.
import { ApiError, VIEWER, nodes, findRepo, listRepos, repos, createRepo } from './store.ts';
import { getCommit, peel } from './gitobj.ts';
import * as ops from './ops.ts';

export const types = {};
const obj = (name, fields, extra) => (types[name] = { kind: 'OBJECT', name, fields, ...(extra || {}) });
const en = (name, values) => (types[name] = { kind: 'ENUM', name, values });
const input = (name, fields) => (types[name] = { kind: 'INPUT_OBJECT', name, inputFields: fields });
for (const s of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML']) types[s] = { kind: 'SCALAR', name: s };

const f = (type, resolve, args) => ({ type, resolve, args: args || null });
const t = (iso) => (iso ? iso.slice(0, 19) + 'Z' : null);
const ent = (item) => (item ? nodes.get(item.nodeId) : null);
const PAGE_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

const cursorOf = (i) => Buffer.from('cursor:v2:' + i).toString('base64');
const indexOf = (c) => {
  const m = /^cursor:v2:(\d+)$/.exec(Buffer.from(String(c), 'base64').toString('utf8'));
  return m ? Number(m[1]) : -1;
};

// Relay-style window over an already ordered list.
export function connection(items, a) {
  let lo = 0;
  let hi = items.length;
  if (a.after != null) lo = Math.max(lo, indexOf(a.after) + 1);
  if (a.before != null) {
    const b = indexOf(a.before);
    if (b >= 0) hi = Math.min(hi, b);
  }
  let start = lo;
  let end = hi;
  if (typeof a.first === 'number') end = Math.min(end, start + Math.max(0, a.first));
  else if (typeof a.last === 'number') start = Math.max(start, end - Math.max(0, a.last));
  else end = Math.min(end, start + 30);
  if (end < start) end = start;
  const edges = [];
  for (let i = start; i < end; i++) edges.push({ node: items[i], cursor: cursorOf(i) });
  return {
    nodes: edges.map((e) => e.node),
    edges,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: end < hi,
      hasPreviousPage: start > lo,
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
  };
}

function conn(name, nodeType) {
  obj(name + 'Edge', { node: f(nodeType), cursor: f('String!') });
  obj(name + 'Connection', {
    nodes: f('[' + nodeType + ']'),
    edges: f('[' + name + 'Edge]'),
    pageInfo: f('PageInfo!'),
    totalCount: f('Int!'),
  });
}

obj('PageInfo', { hasNextPage: f('Boolean!'), hasPreviousPage: f('Boolean!'), startCursor: f('String'), endCursor: f('String') });
conn('Issue', 'Issue');
conn('PullRequest', 'PullRequest');
conn('IssueComment', 'IssueComment');
conn('Repository', 'Repository');
conn('Label', 'Label');
conn('Ref', 'Ref');
conn('PullRequestChangedFile', 'PullRequestChangedFile');
conn('SearchResultItem', 'SearchResultItem');
types.SearchResultItemConnection.fields.issueCount = f('Int!');
types.SearchResultItemConnection.fields.repositoryCount = f('Int!');

en('IssueState', ['OPEN', 'CLOSED']);
en('IssueStateReason', ['COMPLETED', 'NOT_PLANNED', 'REOPENED']);
en('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']);
en('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
en('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']);
en('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
en('RepositoryVisibility', ['PUBLIC', 'PRIVATE', 'INTERNAL']);
en('OrderDirection', ['ASC', 'DESC']);
en('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
en('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION']);
en('PatchStatus', ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED']);
input('IssueOrder', { field: 'IssueOrderField!', direction: 'OrderDirection!' });
input('CreateIssueInput', { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', clientMutationId: 'String' });
input('CloseIssueInput', { issueId: 'ID!', stateReason: 'IssueStateReason', clientMutationId: 'String' });
input('ReopenIssueInput', { issueId: 'ID!', clientMutationId: 'String' });
input('UpdateIssueInput', { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' });
input('CreatePullRequestInput', { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' });
input('MergePullRequestInput', { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' });
input('ClosePullRequestInput', { pullRequestId: 'ID!', clientMutationId: 'String' });
input('AddCommentInput', { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' });
input('CreateRepositoryInput', { name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', ownerId: 'ID', clientMutationId: 'String' });

const userNode = (login) => ({ kind: login === VIEWER.login || !/-org$/.test(login) ? 'User' : 'Organization', login });
const userFields = {
  id: f('ID!', (u) => Buffer.from('04:User' + u.login).toString('base64')),
  login: f('String!', (u) => u.login),
  name: f('String', (u) => (u.login === VIEWER.login ? VIEWER.name : null)),
  email: f('String!', (u) => (u.login === VIEWER.login ? VIEWER.email : '')),
  databaseId: f('Int', (u) => (u.login === VIEWER.login ? VIEWER.id : null)),
  url: f('URI!', (u, a, c) => c.base + '/' + u.login),
  avatarUrl: f('URI!', (u, a, c) => c.base + '/avatars/' + u.login),
  repositories: f('RepositoryConnection!', (u, a) => connection(listRepos(u.login).map(ent), a), { ...PAGE_ARGS }),
  repository: f('Repository', (u, a) => ent(findRepo(u.login, a.name)), { name: 'String!' }),
};
obj('User', userFields);
obj('Organization', userFields);
types.Actor = { kind: 'INTERFACE', name: 'Actor', fields: { login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl }, possible: ['User', 'Organization'] };
types.RepositoryOwner = { kind: 'INTERFACE', name: 'RepositoryOwner', fields: { id: userFields.id, login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl, repositories: userFields.repositories, repository: userFields.repository }, possible: ['User', 'Organization'] };

obj('GitObject', { oid: f('GitObjectID!', (o) => o.oid), id: f('ID!', (o) => Buffer.from('06:Commit' + o.oid).toString('base64')), message: f('String', (o) => o.commit.message), messageHeadline: f('String', (o) => o.commit.message.split('\n')[0]) });
types.Commit = { ...types.GitObject, name: 'Commit' };
obj('Ref', {
  id: f('ID!', (r) => Buffer.from('03:Ref' + r.repo.id + ':' + r.ref).toString('base64')),
  name: f('String!', (r) => r.ref.replace(/^refs\/(heads|tags)\//, '')),
  prefix: f('String!', (r) => r.ref.slice(0, r.ref.indexOf('/', 5) + 1)),
  target: f('GitObject', (r) => {
    const oid = peel(r.repo.objects, r.repo.refs.get(r.ref));
    const commit = oid && getCommit(r.repo.objects, oid);
    return commit ? { oid, commit } : null;
  }),
});
const refOf = (repo, ref) => (repo.refs.has(ref) ? { repo, ref } : null);

obj('Label', { id: f('ID!', (l) => l.nodeId), name: f('String!', (l) => l.name), color: f('String!', (l) => l.color), description: f('String', (l) => l.description) });
obj('PullRequestChangedFile', {
  path: f('String!', (x) => x.filename),
  additions: f('Int!', (x) => x.additions),
  deletions: f('Int!', (x) => x.deletions),
  changeType: f('PatchStatus!', (x) => (x.status === 'added' ? 'ADDED' : x.status === 'removed' ? 'DELETED' : 'MODIFIED')),
});

obj('IssueComment', {
  id: f('ID!', (e) => e.item.nodeId),
  databaseId: f('Int', (e) => e.item.id),
  body: f('String!', (e) => e.item.body),
  bodyText: f('String!', (e) => e.item.body),
  author: f('Actor', () => userNode(VIEWER.login)),
  createdAt: f('DateTime!', (e) => t(e.item.createdAt)),
  updatedAt: f('DateTime!', (e) => t(e.item.updatedAt)),
  url: f('URI!', (e, a, c) => c.base + '/' + e.repo.fullName + '/issues/' + e.item.issue.number + '#issuecomment-' + e.item.id),
  issue: f('Issue', (e) => (e.item.issue.pull ? null : ent(e.item.issue))),
});

const itemFields = {
  id: f('ID!', (e) => e.item.nodeId),
  databaseId: f('Int', (e) => e.item.id),
  number: f('Int!', (e) => e.item.number),
  title: f('String!', (e) => e.item.title),
  body: f('String!', (e) => e.item.body),
  bodyText: f('String!', (e) => e.item.body),
  closed: f('Boolean!', (e) => e.item.state === 'closed'),
  author: f('Actor', () => userNode(VIEWER.login)),
  createdAt: f('DateTime!', (e) => t(e.item.createdAt)),
  updatedAt: f('DateTime!', (e) => t(e.item.updatedAt)),
  closedAt: f('DateTime', (e) => t(e.item.closedAt)),
  repository: f('Repository!', (e) => ent(e.repo)),
  comments: f('IssueCommentConnection!', (e, a) => connection(e.item.comments.map(ent), a), { ...PAGE_ARGS }),
  labels: f('LabelConnection', (e, a) => connection(e.item.labels, a), { ...PAGE_ARGS }),
  viewerCanUpdate: f('Boolean!', () => true),
};
obj('Issue', {
  ...itemFields,
  state: f('IssueState!', (e) => (e.item.state === 'open' ? 'OPEN' : 'CLOSED')),
  stateReason: f('IssueStateReason', (e) => (e.item.stateReason ? e.item.stateReason.toUpperCase() : null)),
  url: f('URI!', (e, a, c) => c.base + '/' + e.repo.fullName + '/issues/' + e.item.number),
});
obj('PullRequest', {
  ...itemFields,
  state: f('PullRequestState!', (e) => (e.item.pull.merged ? 'MERGED' : e.item.state === 'open' ? 'OPEN' : 'CLOSED')),
  url: f('URI!', (e, a, c) => c.base + '/' + e.repo.fullName + '/pull/' + e.item.number),
  headRefName: f('String!', (e) => e.item.pull.head),
  baseRefName: f('String!', (e) => e.item.pull.base),
  headRefOid: f('GitObjectID!', (e) => ops.pullTips(e.repo, e.item).headSha),
  baseRefOid: f('GitObjectID!', (e) => ops.pullTips(e.repo, e.item).baseSha),
  headRef: f('Ref', (e) => refOf(e.repo, 'refs/heads/' + e.item.pull.head)),
  baseRef: f('Ref', (e) => refOf(e.repo, 'refs/heads/' + e.item.pull.base)),
  isDraft: f('Boolean!', (e) => e.item.pull.draft),
  merged: f('Boolean!', (e) => e.item.pull.merged),
  mergedAt: f('DateTime', (e) => t(e.item.pull.mergedAt)),
  mergeable: f('MergeableState!', (e) => {
    const ok = ops.mergeable(e.repo, e.item);
    return ok === null ? 'UNKNOWN' : ok ? 'MERGEABLE' : 'CONFLICTING';
  }),
  mergeCommit: f('Commit', (e) => (e.item.pull.mergeSha ? { oid: e.item.pull.mergeSha, commit: getCommit(e.repo.objects, e.item.pull.mergeSha) } : null)),
  changedFiles: f('Int!', (e) => ops.pullFiles(e.repo, e.item).length),
  additions: f('Int!', (e) => ops.pullFiles(e.repo, e.item).reduce((s, x) => s + x.additions, 0)),
  deletions: f('Int!', (e) => ops.pullFiles(e.repo, e.item).reduce((s, x) => s + x.deletions, 0)),
  files: f('PullRequestChangedFileConnection', (e, a) => connection(ops.pullFiles(e.repo, e.item), a), { ...PAGE_ARGS }),
});

function orderItems(list, a, stateOf) {
  let out = list;
  if (Array.isArray(a.states) && a.states.length) out = out.filter((it) => a.states.includes(stateOf(it)));
  if (Array.isArray(a.labels) && a.labels.length) {
    const want = a.labels.map((l) => String(l).toLowerCase());
    out = out.filter((it) => it.labels.some((l) => want.includes(l.name.toLowerCase())));
  }
  if (a.headRefName) out = out.filter((it) => it.pull && it.pull.head === a.headRefName);
  if (a.baseRefName) out = out.filter((it) => it.pull && it.pull.base === a.baseRefName);
  out = out.slice();
  const field = a.orderBy && a.orderBy.field;
  if (field === 'UPDATED_AT') out.sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : x.updatedAt > y.updatedAt ? 1 : x.number - y.number));
  else if (field === 'COMMENTS') out.sort((x, y) => x.comments.length - y.comments.length || x.number - y.number);
  if (a.orderBy && a.orderBy.direction === 'DESC') out.reverse();
  return out.map(ent);
}
const issueState = (it) => (it.state === 'open' ? 'OPEN' : 'CLOSED');
const pullState = (it) => (it.pull.merged ? 'MERGED' : it.state === 'open' ? 'OPEN' : 'CLOSED');

obj('Repository', {
  id: f('ID!', (e) => e.repo.nodeId),
  databaseId: f('Int', (e) => e.repo.id),
  name: f('String!', (e) => e.repo.name),
  nameWithOwner: f('String!', (e) => e.repo.fullName),
  description: f('String', (e) => e.repo.description),
  url: f('URI!', (e, a, c) => c.base + '/' + e.repo.fullName),
  owner: f('RepositoryOwner!', (e) => userNode(e.repo.owner)),
  isPrivate: f('Boolean!', (e) => e.repo.private),
  visibility: f('RepositoryVisibility!', (e) => (e.repo.private ? 'PRIVATE' : 'PUBLIC')),
  isFork: f('Boolean!', () => false),
  isArchived: f('Boolean!', () => false),
  isEmpty: f('Boolean!', (e) => e.repo.refs.size === 0),
  createdAt: f('DateTime!', (e) => t(e.repo.createdAt)),
  updatedAt: f('DateTime!', (e) => t(e.repo.updatedAt)),
  pushedAt: f('DateTime', (e) => t(e.repo.pushedAt)),
  defaultBranchRef: f('Ref', (e) => refOf(e.repo, 'refs/heads/' + e.repo.defaultBranch)),
  ref: f('Ref', (e, a) => refOf(e.repo, a.qualifiedName.startsWith('refs/') ? a.qualifiedName : 'refs/heads/' + a.qualifiedName), { qualifiedName: 'String!' }),
  refs: f('RefConnection', (e, a) => connection([...e.repo.refs.keys()].filter((r) => r.startsWith(a.refPrefix || 'refs/')).sort().map((r) => ({ repo: e.repo, ref: r })), a), { refPrefix: 'String!', ...PAGE_ARGS }),
  viewerPermission: f('RepositoryPermission', () => 'ADMIN'),
  viewerCanAdminister: f('Boolean!', () => true),
  hasIssuesEnabled: f('Boolean!', (e) => e.repo.hasIssues),
  issue: f('Issue', (e, a) => {
    const it = e.repo.issues.get(a.number);
    return it && !it.pull ? ent(it) : null;
  }, { number: 'Int!' }),
  pullRequest: f('PullRequest', (e, a) => {
    const it = e.repo.issues.get(a.number);
    return it && it.pull ? ent(it) : null;
  }, { number: 'Int!' }),
  issueOrPullRequest: f('IssueOrPullRequest', (e, a) => ent(e.repo.issues.get(a.number)), { number: 'Int!' }),
  issues: f('IssueConnection!', (e, a) => connection(orderItems(e.repo.issueList, a, issueState), a), { ...PAGE_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' }),
  pullRequests: f('PullRequestConnection!', (e, a) => connection(orderItems(e.repo.pullList, a, pullState), a), { ...PAGE_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', labels: '[String!]', headRefName: 'String', baseRefName: 'String' }),
  labels: f('LabelConnection', (e, a) => connection([...e.repo.labels.values()], a), { ...PAGE_ARGS, query: 'String' }),
  label: f('Label', (e, a) => e.repo.labels.get(String(a.name).toLowerCase()) || null, { name: 'String!' }),
});

types.Node = { kind: 'INTERFACE', name: 'Node', fields: { id: f('ID!', (e) => (e.repo && e.kind === 'Repository' ? e.repo.nodeId : e.item.nodeId)) }, possible: ['Repository', 'Issue', 'PullRequest', 'IssueComment'] };
types.IssueOrPullRequest = { kind: 'UNION', name: 'IssueOrPullRequest', fields: {}, possible: ['Issue', 'PullRequest'] };
types.SearchResultItem = { kind: 'UNION', name: 'SearchResultItem', fields: {}, possible: ['Issue', 'PullRequest', 'Repository'] };
input('IssueFilters', { states: '[IssueState!]', labels: '[String!]' });

function search(a) {
  const words = [];
  let repoFilter = null;
  let want = null;
  let state = null;
  for (const term of String(a.query || '').split(/\s+/).filter(Boolean)) {
    const low = term.toLowerCase();
    if (low.startsWith('repo:')) repoFilter = low.slice(5);
    else if (low === 'is:issue' || low === 'type:issue') want = 'issue';
    else if (low === 'is:pr' || low === 'type:pr') want = 'pr';
    else if (low === 'is:open' || low === 'state:open') state = 'open';
    else if (low === 'is:closed' || low === 'state:closed') state = 'closed';
    else if (!/^[a-z]+:/.test(low)) words.push(low.replace(/^"|"$/g, ''));
  }
  const out = [];
  for (const r of repos.values()) {
    if (repoFilter && r.fullName.toLowerCase() !== repoFilter) continue;
    if (a.type === 'REPOSITORY') {
      if (words.every((w) => r.fullName.toLowerCase().includes(w) || (r.description || '').toLowerCase().includes(w))) out.push(ent(r));
      continue;
    }
    if (a.type !== 'ISSUE') continue;
    for (const it of r.issues.values()) {
      if (want === 'issue' && it.pull) continue;
      if (want === 'pr' && !it.pull) continue;
      if (state && it.state !== state) continue;
      const hay = (it.title + '\n' + it.body).toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(ent(it));
    }
  }
  const c = connection(out, a);
  c.issueCount = a.type === 'ISSUE' ? out.length : 0;
  c.repositoryCount = a.type === 'REPOSITORY' ? out.length : 0;
  return c;
}

obj('RateLimit', { limit: f('Int!'), cost: f('Int!'), remaining: f('Int!'), used: f('Int!'), resetAt: f('DateTime!'), nodeCount: f('Int!') });
obj('Query', {
  viewer: f('User!', () => userNode(VIEWER.login)),
  repository: f('Repository', (s, a) => ent(findRepo(a.owner, a.name)), { owner: 'String!', name: 'String!', followRenames: 'Boolean' }),
  node: f('Node', (s, a) => nodes.get(a.id) || null, { id: 'ID!' }),
  nodes: f('[Node]!', (s, a) => (a.ids || []).map((id) => nodes.get(id) || null), { ids: '[ID!]!' }),
  user: f('User', (s, a) => (a.login === VIEWER.login || listRepos(a.login).length ? userNode(a.login) : null), { login: 'String!' }),
  repositoryOwner: f('RepositoryOwner', (s, a) => (a.login === VIEWER.login || listRepos(a.login).length ? userNode(a.login) : null), { login: 'String!' }),
  organization: f('Organization', (s, a) => (/-org$/.test(a.login) ? { kind: 'Organization', login: a.login } : null), { login: 'String!' }),
  search: f('SearchResultItemConnection!', (s, a) => search(a), { query: 'String!', type: 'SearchType!', ...PAGE_ARGS }),
  rateLimit: f('RateLimit', () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: t(new Date(Date.now() + 3600000).toISOString()), nodeCount: 1 }), { dryRun: 'Boolean' }),
});

// ---- mutations
function need(id, kinds, what) {
  const e = nodes.get(id);
  if (!e || !kinds.includes(e.kind)) throw new ApiError(404, "Could not resolve to a node with the global id of '" + id + "'");
  return e;
}
const payload = (name, fields) => obj(name, { clientMutationId: f('String'), ...fields });
payload('CreateIssuePayload', { issue: f('Issue') });
payload('CloseIssuePayload', { issue: f('Issue') });
payload('ReopenIssuePayload', { issue: f('Issue') });
payload('UpdateIssuePayload', { issue: f('Issue') });
payload('CreatePullRequestPayload', { pullRequest: f('PullRequest') });
payload('MergePullRequestPayload', { pullRequest: f('PullRequest') });
payload('ClosePullRequestPayload', { pullRequest: f('PullRequest') });
payload('AddCommentPayload', { commentEdge: f('IssueCommentEdge'), subject: f('Node'), timelineEdge: f('IssueCommentEdge') });
payload('CreateRepositoryPayload', { repository: f('Repository') });

const mid = (a) => (a.input && typeof a.input.clientMutationId === 'string' ? a.input.clientMutationId : null);
obj('Mutation', {
  createIssue: f('CreateIssuePayload', (s, a) => {
    const e = need(a.input.repositoryId, ['Repository']);
    const labels = (a.input.labelIds || []).map((id) => [...e.repo.labels.values()].find((l) => l.nodeId === id)).filter(Boolean).map((l) => l.name);
    const it = ops.createIssue(e.repo, { title: a.input.title, body: a.input.body, labels });
    return { clientMutationId: mid(a), issue: ent(it) };
  }, { input: 'CreateIssueInput!' }),
  closeIssue: f('CloseIssuePayload', (s, a) => {
    const e = need(a.input.issueId, ['Issue']);
    ops.setState(e.item, 'closed', a.input.stateReason ? String(a.input.stateReason).toLowerCase() : null);
    return { clientMutationId: mid(a), issue: e };
  }, { input: 'CloseIssueInput!' }),
  reopenIssue: f('ReopenIssuePayload', (s, a) => {
    const e = need(a.input.issueId, ['Issue']);
    ops.setState(e.item, 'open', null);
    return { clientMutationId: mid(a), issue: e };
  }, { input: 'ReopenIssueInput!' }),
  updateIssue: f('UpdateIssuePayload', (s, a) => {
    const e = need(a.input.id, ['Issue']);
    const patch = {};
    if (typeof a.input.title === 'string') patch.title = a.input.title;
    if (typeof a.input.body === 'string') patch.body = a.input.body;
    if (a.input.state) patch.state = String(a.input.state).toLowerCase();
    ops.updateItem(e.repo, e.item, patch);
    return { clientMutationId: mid(a), issue: e };
  }, { input: 'UpdateIssueInput!' }),
  createPullRequest: f('CreatePullRequestPayload', (s, a) => {
    const e = need(a.input.repositoryId, ['Repository']);
    const it = ops.createPull(e.repo, { title: a.input.title, body: a.input.body, head: a.input.headRefName, base: a.input.baseRefName, draft: a.input.draft });
    return { clientMutationId: mid(a), pullRequest: ent(it) };
  }, { input: 'CreatePullRequestInput!' }),
  mergePullRequest: f('MergePullRequestPayload', (s, a) => {
    const e = need(a.input.pullRequestId, ['PullRequest']);
    ops.mergePull(e.repo, e.item, { merge_method: a.input.mergeMethod ? String(a.input.mergeMethod).toLowerCase() : 'merge', commit_title: a.input.commitHeadline, commit_message: a.input.commitBody, sha: a.input.expectedHeadOid });
    return { clientMutationId: mid(a), pullRequest: e };
  }, { input: 'MergePullRequestInput!' }),
  closePullRequest: f('ClosePullRequestPayload', (s, a) => {
    const e = need(a.input.pullRequestId, ['PullRequest']);
    ops.setState(e.item, 'closed', null);
    return { clientMutationId: mid(a), pullRequest: e };
  }, { input: 'ClosePullRequestInput!' }),
  addComment: f('AddCommentPayload', (s, a) => {
    const e = need(a.input.subjectId, ['Issue', 'PullRequest']);
    const c = ops.addComment(e.repo, e.item, a.input.body);
    const edge = { node: ent(c), cursor: cursorOf(e.item.comments.length - 1) };
    return { clientMutationId: mid(a), commentEdge: edge, timelineEdge: edge, subject: e };
  }, { input: 'AddCommentInput!' }),
  createRepository: f('CreateRepositoryPayload', (s, a) => {
    const repo = createRepo(VIEWER.login, { name: a.input.name, description: a.input.description, private: a.input.visibility !== 'PUBLIC' });
    return { clientMutationId: mid(a), repository: ent(repo) };
  }, { input: 'CreateRepositoryInput!' }),
});

// Concrete type name of a runtime value seen through an interface or union.
export function runtimeType(value) {
  if (value && typeof value.kind === 'string' && types[value.kind]) return value.kind;
  return null;
}
