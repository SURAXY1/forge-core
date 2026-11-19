// MCP endpoint (JSON-RPC over HTTP POST): discovery, initialization, tools/list and tools/call.
import { ApiError, VIEWER, needRepo, createRepo, listRepos } from './store.ts';
import { getCommit, lookupPath, walkHistory } from './gitobj.ts';
import * as ops from './ops.ts';
import * as S from './shapes.ts';

const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-core', title: 'forge-core git forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = 'Tools act on the repositories, issues and pull requests of this forge as the token owner. Results are JSON text shaped like the GitHub REST API.';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'integer', description });
const OWNER = str('Account that owns the repository');
const REPO = str('Repository name');
const tool = (name, title, description, properties, required) => ({ name, title, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { title } });

const impl = {};
const TOOLS = [];
function define(name, title, description, properties, required, run) {
  TOOLS.push(tool(name, title, description, properties, required));
  impl[name] = { required, properties, run };
}

const repoOf = (a) => needRepo(a.owner, a.repo);
const itemOf = (a, key, wantPull) => {
  const repo = repoOf(a);
  const it = repo.issues.get(Number(a[key]));
  if (!it || (wantPull && !it.pull)) throw new ApiError(404, 'Not Found');
  return { repo, it };
};

define('create_repo', 'Create repository', 'Create a new repository owned by the authenticated user.', { name: str('Repository name'), description: str('Short description'), private: { type: 'boolean', description: 'Whether the repository is private' }, auto_init: { type: 'boolean', description: 'Create an initial commit with a README' } }, ['name'], (a, base) => {
  const repo = createRepo(VIEWER.login, a);
  if (a.auto_init === true) ops.writeFile(repo, 'README.md', { message: 'Initial commit' }, Buffer.from('# ' + repo.name + '\n'));
  return S.repoJson(base, repo);
});
define('get_repo', 'Get repository', 'Read one repository by owner and name.', { owner: OWNER, repo: REPO }, ['owner', 'repo'], (a, base) => S.repoJson(base, repoOf(a)));
define('list_repos', 'List repositories', 'List the repositories owned by the authenticated user.', {}, [], (a, base) => listRepos(VIEWER.login).map((r) => S.repoJson(base, r)));
define('create_issue', 'Create issue', 'Open a new issue in a repository.', { owner: OWNER, repo: REPO, title: str('Issue title'), body: str('Issue body (markdown)'), labels: { type: 'array', items: { type: 'string' }, description: 'Names of existing labels to apply' } }, ['owner', 'repo', 'title'], (a, base) => {
  const repo = repoOf(a);
  return S.issueJson(base, repo, ops.createIssue(repo, a));
});
define('get_issue', 'Get issue', 'Read one issue by number.', { owner: OWNER, repo: REPO, issue_number: num('Issue number') }, ['owner', 'repo', 'issue_number'], (a, base) => {
  const { repo, it } = itemOf(a, 'issue_number', false);
  return S.issueJson(base, repo, it);
});
define('list_issues', 'List issues', 'List the issues of a repository, newest first. Pull requests are not included.', { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list (default open)' } }, ['owner', 'repo'], (a, base) => {
  const repo = repoOf(a);
  const state = a.state === undefined || a.state === null ? 'open' : String(a.state).toLowerCase();
  if (!['open', 'closed', 'all'].includes(state)) throw new ApiError(422, 'state must be open, closed or all');
  return repo.issueList.filter((it) => state === 'all' || it.state === state).reverse().map((it) => S.issueJson(base, repo, it));
});
define('update_issue', 'Update issue', 'Change the title, body or state of an issue.', { owner: OWNER, repo: REPO, issue_number: num('Issue number'), title: str('New title'), body: str('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } }, ['owner', 'repo', 'issue_number'], (a, base) => {
  const { repo, it } = itemOf(a, 'issue_number', false);
  const patch = {};
  for (const k of ['title', 'body', 'state']) if (a[k] !== undefined) patch[k] = a[k];
  return S.issueJson(base, repo, ops.updateItem(repo, it, patch));
});
define('add_issue_comment', 'Comment on issue', 'Add a comment to an issue or pull request.', { owner: OWNER, repo: REPO, issue_number: num('Issue or pull request number'), body: str('Comment body') }, ['owner', 'repo', 'issue_number', 'body'], (a, base) => {
  const { repo, it } = itemOf(a, 'issue_number', false);
  return S.commentJson(base, repo, ops.addComment(repo, it, a.body));
});
define('create_pull_request', 'Create pull request', 'Open a pull request asking to merge the head branch into the base branch.', { owner: OWNER, repo: REPO, title: str('Pull request title'), head: str('Branch that holds the changes'), base: str('Branch to merge into'), body: str('Pull request description') }, ['owner', 'repo', 'title', 'head', 'base'], (a, base) => {
  const repo = repoOf(a);
  return S.pullJson(base, repo, ops.createPull(repo, a), true);
});
define('get_pull_request', 'Get pull request', 'Read one pull request by number.', { owner: OWNER, repo: REPO, pull_number: num('Pull request number') }, ['owner', 'repo', 'pull_number'], (a, base) => {
  const { repo, it } = itemOf(a, 'pull_number', true);
  return S.pullJson(base, repo, it, true);
});
define('list_pull_requests', 'List pull requests', 'List the pull requests of a repository, newest first.', { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list (default open)' } }, ['owner', 'repo'], (a, base) => {
  const repo = repoOf(a);
  const state = a.state === undefined || a.state === null ? 'open' : String(a.state).toLowerCase();
  return repo.pullList.filter((it) => state === 'all' || it.state === state).reverse().map((it) => S.pullJson(base, repo, it, false));
});
define('merge_pull_request', 'Merge pull request', 'Merge an open pull request into its base branch.', { owner: OWNER, repo: REPO, pull_number: num('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge (default merge)' }, commit_title: str('Title of the merge commit') }, ['owner', 'repo', 'pull_number'], (a, base) => {
  const { repo, it } = itemOf(a, 'pull_number', true);
  const sha = ops.mergePull(repo, it, a);
  return { merged: true, sha, message: 'Pull Request successfully merged', number: it.number, state: it.state, merged_at: S.pullJson(base, repo, it, false).merged_at };
});
define('list_branches', 'List branches', 'List the branches of a repository.', { owner: OWNER, repo: REPO }, ['owner', 'repo'], (a, base) => {
  const repo = repoOf(a);
  return [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => S.branchJson(base, repo, r.slice(11), false));
});
define('create_branch', 'Create branch', 'Create a branch from another branch (the default branch unless from_branch is given).', { owner: OWNER, repo: REPO, branch: str('Name of the new branch'), from_branch: str('Branch to start from') }, ['owner', 'repo', 'branch'], (a, base) => {
  const repo = repoOf(a);
  const from = ops.resolveCommit(repo, typeof a.from_branch === 'string' ? a.from_branch : '');
  if (!from) throw new ApiError(404, 'The starting branch does not exist');
  const ref = 'refs/heads/' + a.branch;
  if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
  ops.setRef(repo, ref, from);
  return S.refJson(base, repo, ref);
});
define('list_commits', 'List commits', 'List the commits reachable from a branch, newest first.', { owner: OWNER, repo: REPO, sha: str('Branch name or commit id (default: the default branch)') }, ['owner', 'repo'], (a, base) => {
  const repo = repoOf(a);
  const tip = ops.resolveCommit(repo, typeof a.sha === 'string' ? a.sha : '');
  if (!tip) throw new ApiError(404, 'Not Found');
  return walkHistory(repo.objects, tip, 100).map((sha) => S.commitJson(base, repo, sha));
});
define('get_file_contents', 'Get file contents', 'Read a file from a repository as text.', { owner: OWNER, repo: REPO, path: str('Path of the file'), ref: str('Branch, tag or commit (default: the default branch)') }, ['owner', 'repo', 'path'], (a) => {
  const repo = repoOf(a);
  const commit = ops.resolveCommit(repo, typeof a.ref === 'string' ? a.ref : '');
  if (!commit) throw new ApiError(404, 'Not Found');
  const path = String(a.path).replace(/^\/+|\/+$/g, '');
  const hit = lookupPath(repo.objects, getCommit(repo.objects, commit).tree, path);
  if (!hit || hit.mode === '40000') throw new ApiError(404, 'Not Found');
  const data = repo.objects.get(hit.oid).data;
  return { type: 'file', path, sha: hit.oid, size: data.length, encoding: 'utf-8', content: data.toString('utf8') };
});
define('create_or_update_file', 'Write file', 'Create or replace one file with a commit on a branch.', { owner: OWNER, repo: REPO, path: str('Path of the file'), content: str('New file content as plain text'), message: str('Commit message'), branch: str('Branch to commit to (default: the default branch)'), sha: str('Blob id of the file being replaced, required when it exists') }, ['owner', 'repo', 'path', 'content', 'message'], (a, base) => {
  const repo = repoOf(a);
  const res = ops.writeFile(repo, a.path, a, Buffer.from(String(a.content), 'utf8'));
  return { content: { path: res.path, sha: res.blob, type: 'file' }, commit: { sha: res.commit, message: a.message } };
});

const TOOLS_RESULT = { tools: TOOLS };

function typeOk(schema, v) {
  if (schema.type === 'string') return typeof v === 'string';
  if (schema.type === 'integer') return (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^\d+$/.test(v));
  if (schema.type === 'boolean') return typeof v === 'boolean';
  if (schema.type === 'array') return Array.isArray(v);
  return true;
}

function callTool(params, base) {
  const name = params && params.name;
  if (typeof name !== 'string' || !impl[name]) return { error: { code: -32602, message: 'Unknown tool: ' + String(name) } };
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  const failed = (text) => ({ result: { content: [{ type: 'text', text }], isError: true } });
  if (typeof args !== 'object' || Array.isArray(args)) return failed('arguments must be an object');
  const t = impl[name];
  const missing = t.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) return failed('Missing required argument' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', '));
  for (const k of Object.keys(t.properties)) {
    if (args[k] !== undefined && args[k] !== null && !typeOk(t.properties[k], args[k])) return failed('Argument ' + k + ' must be of type ' + t.properties[k].type);
  }
  try {
    const value = t.run(args, base);
    const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false };
    result.structuredContent = Array.isArray(value) ? { items: value } : value;
    return { result };
  } catch (e) {
    if (e instanceof ApiError) {
      const detail = Array.isArray(e.extra) && e.extra[0] && e.extra[0].message ? ': ' + e.extra[0].message : '';
      return failed(e.message + detail + ' (HTTP ' + e.status + ')');
    }
    return failed('Tool failed: ' + String((e && e.message) || e));
  }
}

function handleOne(msg, ctx) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const hasId = msg.id !== undefined && msg.id !== null;
  const id = hasId ? msg.id : null;
  const done = (result) => (hasId ? { jsonrpc: '2.0', id, result } : null);
  const fail = (code, message, data) => (hasId ? { jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } } : null);
  if (typeof msg.method !== 'string') {
    if (msg.result !== undefined || msg.error !== undefined) return null; // a client response; nothing to answer
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const version = typeof asked === 'string' && VERSIONS.includes(asked) ? asked : '2025-11-25';
      return done({ protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'server/discover':
      return done({ supportedVersions: VERSIONS, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case 'ping':
      return done({});
    case 'tools/list':
      return done(TOOLS_RESULT);
    case 'tools/call': {
      const out = callTool(params, ctx.base);
      return out.error ? fail(out.error.code, out.error.message) : done(out.result);
    }
    case 'resources/list':
      return done({ resources: [] });
    case 'resources/templates/list':
      return done({ resourceTemplates: [] });
    case 'prompts/list':
      return done({ prompts: [] });
    case 'logging/setLevel':
      return done({});
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, 'Method not found: ' + msg.method);
  }
}

export function handleMcp(ctx) {
  if (ctx.method === 'DELETE') return { status: 200, body: '{}' };
  if (ctx.method !== 'POST') return { status: 405, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Use POST for JSON-RPC messages' } }), headers: ['Allow', 'POST, DELETE'] };
  let msg;
  try {
    msg = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } }) };
  }
  const want = ctx.headers['mcp-protocol-version'];
  if (typeof want === 'string' && want !== '' && !VERSIONS.includes(want)) {
    const id = msg && typeof msg === 'object' && !Array.isArray(msg) && msg.id !== undefined ? msg.id : null;
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32022, message: 'Unsupported protocol version: ' + want, data: { supported: VERSIONS, requested: want } } }) };
  }
  if (Array.isArray(msg)) {
    if (msg.length === 0) return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
    const out = msg.map((m) => handleOne(m, ctx)).filter((r) => r !== null);
    return out.length ? { status: 200, body: JSON.stringify(out) } : { status: 202, body: '' };
  }
  const out = handleOne(msg, ctx);
  if (out === null) return { status: 202, body: '' };
  return { status: 200, body: JSON.stringify(out) };
}
