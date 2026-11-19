// REST v3 response shapes. Every function returns a plain object ready for JSON.stringify.
import { VIEWER } from './store.ts';
import { getCommit, parseIdent, peel } from './gitobj.ts';
import { pullTips, mergeable } from './ops.ts';

const t = (iso) => (iso ? iso.slice(0, 19) + 'Z' : null);
const userCache = new Map();

export function userJson(base, login) {
  const key = base + '|' + login;
  let u = userCache.get(key);
  if (u) return u;
  const isViewer = login === VIEWER.login;
  const isOrg = /-org$/.test(login);
  let id = VIEWER.id;
  if (!isViewer) {
    id = 2000;
    for (let i = 0; i < login.length; i++) id = (id * 31 + login.charCodeAt(i)) % 900000;
    id += 2000;
  }
  const api = base + '/api/v3/users/' + login;
  u = {
    login,
    id,
    node_id: Buffer.from('04:User' + id).toString('base64'),
    avatar_url: base + '/avatars/u/' + id,
    gravatar_id: '',
    url: api,
    html_url: base + '/' + login,
    followers_url: api + '/followers',
    following_url: api + '/following{/other_user}',
    gists_url: api + '/gists{/gist_id}',
    starred_url: api + '/starred{/owner}{/repo}',
    subscriptions_url: api + '/subscriptions',
    organizations_url: api + '/orgs',
    repos_url: api + '/repos',
    events_url: api + '/events{/privacy}',
    received_events_url: api + '/received_events',
    type: isOrg ? 'Organization' : 'User',
    site_admin: false,
  };
  if (userCache.size < 1000) userCache.set(key, u);
  return u;
}

export function viewerJson(base) {
  return {
    ...userJson(base, VIEWER.login),
    name: VIEWER.name,
    company: null,
    blog: '',
    location: null,
    email: VIEWER.email,
    hireable: null,
    bio: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  };
}

export function repoJson(base, r) {
  const api = base + '/api/v3/repos/' + r.fullName;
  const html = base + '/' + r.fullName;
  return {
    id: r.id,
    node_id: r.nodeId,
    name: r.name,
    full_name: r.fullName,
    private: r.private,
    owner: userJson(base, r.owner),
    html_url: html,
    description: r.description,
    fork: false,
    url: api,
    branches_url: api + '/branches{/branch}',
    commits_url: api + '/commits{/sha}',
    contents_url: api + '/contents/{+path}',
    git_refs_url: api + '/git/refs{/sha}',
    issues_url: api + '/issues{/number}',
    pulls_url: api + '/pulls{/number}',
    labels_url: api + '/labels{/name}',
    created_at: t(r.createdAt),
    updated_at: t(r.updatedAt),
    pushed_at: t(r.pushedAt),
    git_url: 'git:' + html.replace(/^https?:/, '') + '.git',
    ssh_url: 'git@' + base.replace(/^https?:\/\//, '') + ':' + r.fullName + '.git',
    clone_url: html + '.git',
    homepage: r.homepage,
    size: r.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: r.hasIssues,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: countOpen(r),
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: r.private ? 'private' : 'public',
    forks: 0,
    open_issues: countOpen(r),
    watchers: 0,
    default_branch: r.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    network_count: 0,
    subscribers_count: 0,
  };
}

function countOpen(r) {
  let n = 0;
  for (const it of r.issues.values()) if (it.state === 'open') n++;
  return n;
}

export function labelJson(base, r, l) {
  return {
    id: l.id,
    node_id: l.nodeId,
    url: base + '/api/v3/repos/' + r.fullName + '/labels/' + encodeURIComponent(l.name),
    name: l.name,
    color: l.color,
    default: false,
    description: l.description,
  };
}

export function issueJson(base, r, it) {
  const api = base + '/api/v3/repos/' + r.fullName;
  const kind = it.pull ? 'pull' : 'issues';
  const out = {
    url: api + '/issues/' + it.number,
    repository_url: api,
    labels_url: api + '/issues/' + it.number + '/labels{/name}',
    comments_url: api + '/issues/' + it.number + '/comments',
    events_url: api + '/issues/' + it.number + '/events',
    html_url: base + '/' + r.fullName + '/' + kind + '/' + it.number,
    id: it.id,
    node_id: it.nodeId,
    number: it.number,
    title: it.title,
    user: userJson(base, VIEWER.login),
    labels: it.labels.map((l) => labelJson(base, r, l)),
    state: it.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: it.comments.length,
    created_at: t(it.createdAt),
    updated_at: t(it.updatedAt),
    closed_at: t(it.closedAt),
    author_association: 'OWNER',
    active_lock_reason: null,
    body: it.body,
    reactions: { url: api + '/issues/' + it.number + '/reactions', total_count: 0 },
    timeline_url: api + '/issues/' + it.number + '/timeline',
    performed_via_github_app: null,
    state_reason: it.pull ? null : it.stateReason,
  };
  if (it.pull) {
    out.draft = it.pull.draft;
    out.pull_request = {
      url: api + '/pulls/' + it.number,
      html_url: base + '/' + r.fullName + '/pull/' + it.number,
      diff_url: base + '/' + r.fullName + '/pull/' + it.number + '.diff',
      patch_url: base + '/' + r.fullName + '/pull/' + it.number + '.patch',
      merged_at: t(it.pull.mergedAt),
    };
  }
  return out;
}

export function commentJson(base, r, c) {
  const api = base + '/api/v3/repos/' + r.fullName;
  return {
    url: api + '/issues/comments/' + c.id,
    html_url: base + '/' + r.fullName + '/issues/' + c.issue.number + '#issuecomment-' + c.id,
    issue_url: api + '/issues/' + c.issue.number,
    id: c.id,
    node_id: c.nodeId,
    user: userJson(base, VIEWER.login),
    created_at: t(c.createdAt),
    updated_at: t(c.updatedAt),
    author_association: 'OWNER',
    body: c.body,
    reactions: { url: api + '/issues/comments/' + c.id + '/reactions', total_count: 0 },
    performed_via_github_app: null,
  };
}

export function pullJson(base, r, it, full) {
  const api = base + '/api/v3/repos/' + r.fullName;
  const p = pullTips(r, it);
  const repo = repoJson(base, r);
  const owner = userJson(base, r.owner);
  const out = {
    url: api + '/pulls/' + it.number,
    id: it.id,
    node_id: it.nodeId,
    html_url: base + '/' + r.fullName + '/pull/' + it.number,
    diff_url: base + '/' + r.fullName + '/pull/' + it.number + '.diff',
    patch_url: base + '/' + r.fullName + '/pull/' + it.number + '.patch',
    issue_url: api + '/issues/' + it.number,
    number: it.number,
    state: it.state,
    locked: false,
    title: it.title,
    user: userJson(base, VIEWER.login),
    body: it.body,
    created_at: t(it.createdAt),
    updated_at: t(it.updatedAt),
    closed_at: t(it.closedAt),
    merged_at: t(p.mergedAt),
    merge_commit_sha: p.mergeSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: it.labels.map((l) => labelJson(base, r, l)),
    milestone: null,
    draft: p.draft,
    commits_url: api + '/pulls/' + it.number + '/commits',
    review_comments_url: api + '/pulls/' + it.number + '/comments',
    comments_url: api + '/issues/' + it.number + '/comments',
    statuses_url: api + '/statuses/' + p.headSha,
    head: { label: r.owner + ':' + p.head, ref: p.head, sha: p.headSha, user: owner, repo },
    base: { label: r.owner + ':' + p.base, ref: p.base, sha: p.baseSha, user: owner, repo },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: p.merged,
  };
  if (full) {
    const ok = mergeable(r, it);
    out.mergeable = ok;
    out.rebaseable = ok;
    out.mergeable_state = ok === null ? 'unknown' : ok ? 'clean' : 'dirty';
    out.merged_by = p.merged ? userJson(base, VIEWER.login) : null;
    out.comments = it.comments.length;
    out.review_comments = 0;
    out.maintainer_can_modify = false;
  }
  return out;
}

export function commitJson(base, r, sha) {
  const c = getCommit(r.objects, sha);
  const api = base + '/api/v3/repos/' + r.fullName;
  const a = parseIdent(c.author);
  const m = parseIdent(c.committer);
  const who = (id) => (id.email === VIEWER.email ? userJson(base, VIEWER.login) : null);
  return {
    sha,
    node_id: Buffer.from('06:Commit' + sha).toString('base64'),
    commit: {
      author: { name: a.name, email: a.email, date: a.date },
      committer: { name: m.name, email: m.email, date: m.date },
      message: c.message,
      tree: { sha: c.tree, url: api + '/git/trees/' + c.tree },
      url: api + '/git/commits/' + sha,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: api + '/commits/' + sha,
    html_url: base + '/' + r.fullName + '/commit/' + sha,
    comments_url: api + '/commits/' + sha + '/comments',
    author: who(a),
    committer: who(m),
    parents: c.parents.map((p) => ({ sha: p, url: api + '/commits/' + p, html_url: base + '/' + r.fullName + '/commit/' + p })),
  };
}

export function refJson(base, r, ref) {
  const oid = r.refs.get(ref);
  const o = r.objects.get(oid);
  const type = o ? o.type : 'commit';
  return {
    ref,
    node_id: Buffer.from('03:Ref' + r.id + ':' + ref).toString('base64'),
    url: base + '/api/v3/repos/' + r.fullName + '/git/' + ref,
    object: { sha: oid, type, url: base + '/api/v3/repos/' + r.fullName + '/git/' + (type === 'tag' ? 'tags' : 'commits') + '/' + oid },
  };
}

export function branchJson(base, r, name, full) {
  const sha = peel(r.objects, r.refs.get('refs/heads/' + name));
  const api = base + '/api/v3/repos/' + r.fullName;
  if (!full) return { name, commit: { sha, url: api + '/commits/' + sha }, protected: false };
  return {
    name,
    commit: commitJson(base, r, sha),
    _links: { self: api + '/branches/' + encodeURIComponent(name), html: base + '/' + r.fullName + '/tree/' + name },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: api + '/branches/' + encodeURIComponent(name) + '/protection',
  };
}
