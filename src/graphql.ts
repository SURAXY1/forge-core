// GraphQL endpoint: validates a document against the schema table, then executes it.
import { ApiError } from './store.ts';
import { parseDocument } from './gqlparse.ts';
import { types, runtimeType } from './gqlschema.ts';

// ---- introspection types, resolved over the same table
const typeRef = (text) => {
  if (text.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(text.slice(0, -1)) };
  if (text.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(text.slice(1, -1)) };
  return types[text] || { kind: 'SCALAR', name: text };
};
const named = (text) => text.replace(/[\[\]!]/g, '');
const inputValues = (table) => Object.keys(table || {}).map((name) => ({ name, description: null, type: typeRef(table[name]), defaultValue: null }));
const f = (type, resolve, args) => ({ type, resolve, args: args || null });
const DEP = { includeDeprecated: 'Boolean' };

types.__Type = {
  kind: 'OBJECT',
  name: '__Type',
  fields: {
    kind: f('String!'),
    name: f('String'),
    description: f('String', () => null),
    specifiedByURL: f('String', () => null),
    fields: f('[__Field!]', (t) => (t.kind === 'OBJECT' || t.kind === 'INTERFACE' ? Object.keys(t.fields).filter((n) => !n.startsWith('__')).map((name) => ({ name, def: t.fields[name] })) : null), DEP),
    interfaces: f('[__Type!]', (t) => (t.kind === 'OBJECT' ? Object.values(types).filter((i) => i.kind === 'INTERFACE' && i.possible.includes(t.name)) : null)),
    possibleTypes: f('[__Type!]', (t) => (t.possible ? t.possible.map((n) => types[n]) : null)),
    enumValues: f('[__EnumValue!]', (t) => (t.kind === 'ENUM' ? t.values.map((name) => ({ name })) : null), DEP),
    inputFields: f('[__InputValue!]', (t) => (t.kind === 'INPUT_OBJECT' ? inputValues(t.inputFields) : null), DEP),
    ofType: f('__Type', (t) => t.ofType || null),
  },
};
types.__Field = {
  kind: 'OBJECT',
  name: '__Field',
  fields: {
    name: f('String!'),
    description: f('String', () => null),
    args: f('[__InputValue!]!', (x) => inputValues(x.def.args), DEP),
    type: f('__Type!', (x) => typeRef(x.def.type)),
    isDeprecated: f('Boolean!', () => false),
    deprecationReason: f('String', () => null),
  },
};
types.__InputValue = { kind: 'OBJECT', name: '__InputValue', fields: { name: f('String!'), description: f('String'), type: f('__Type!'), defaultValue: f('String'), isDeprecated: f('Boolean!', () => false), deprecationReason: f('String', () => null) } };
types.__EnumValue = { kind: 'OBJECT', name: '__EnumValue', fields: { name: f('String!'), description: f('String', () => null), isDeprecated: f('Boolean!', () => false), deprecationReason: f('String', () => null) } };
types.__Directive = { kind: 'OBJECT', name: '__Directive', fields: { name: f('String!'), description: f('String', () => null), locations: f('[String!]!'), args: f('[__InputValue!]!', (d) => inputValues(d.args), DEP), isRepeatable: f('Boolean!', () => false) } };
types.__Schema = {
  kind: 'OBJECT',
  name: '__Schema',
  fields: {
    description: f('String', () => null),
    queryType: f('__Type!', () => types.Query),
    mutationType: f('__Type', () => types.Mutation),
    subscriptionType: f('__Type', () => null),
    types: f('[__Type!]!', () => Object.values(types)),
    directives: f('[__Directive!]!', () => [
      { name: 'include', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: { if: 'Boolean!' } },
      { name: 'skip', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: { if: 'Boolean!' } },
    ]),
  },
};
types.Query.fields.__type = f('__Type', (s, a) => types[a.name] || null, { name: 'String!' });
types.Query.fields.__schema = f('__Schema!', () => ({}));

// ---- validation
function validate(doc, op) {
  const errors = [];
  const seenFragments = new Set();
  const walk = (selections, typeName, path) => {
    const type = types[typeName];
    for (const sel of selections) {
      if (sel.kind === 'field') {
        if (sel.name === '__typename') continue;
        const def = type && type.fields ? type.fields[sel.name] : null;
        if (!def) {
          errors.push({ path: [...path, sel.alias], extensions: { code: 'undefinedField', typeName, fieldName: sel.name }, message: "Field '" + sel.name + "' doesn't exist on type '" + typeName + "'" });
          continue;
        }
        for (const [argName] of sel.args) {
          if (!def.args || !(argName in def.args)) {
            errors.push({ path: [...path, sel.alias, argName], extensions: { code: 'argumentNotAccepted', name: sel.name, typeName: 'Field', argumentName: argName }, message: "Field '" + sel.name + "' doesn't accept argument '" + argName + "'" });
          }
        }
        if (def.args) {
          for (const argName of Object.keys(def.args)) {
            if (def.args[argName].endsWith('!') && !sel.args.some((a) => a[0] === argName)) {
              errors.push({ path: [...path, sel.alias], extensions: { code: 'missingRequiredArguments', className: 'Field', name: sel.name, arguments: argName }, message: "Field '" + sel.name + "' is missing required arguments: " + argName });
            }
          }
        }
        const inner = types[named(def.type)];
        const composite = inner && (inner.kind === 'OBJECT' || inner.kind === 'INTERFACE' || inner.kind === 'UNION');
        if (composite && !sel.selections) {
          errors.push({ path: [...path, sel.alias], extensions: { code: 'selectionMismatch', nodeName: "field '" + sel.name + "'", typeName: inner.name }, message: "Field must have selections (field '" + sel.name + "' returns " + inner.name + " but has no selections. Did you mean '" + sel.name + " { ... }'?)" });
        } else if (!composite && sel.selections) {
          errors.push({ path: [...path, sel.alias], extensions: { code: 'selectionMismatch', nodeName: "field '" + sel.name + "'", typeName: named(def.type) }, message: "Selections can't be made on scalars (field '" + sel.name + "' returns " + named(def.type) + ' but has selections)' });
        } else if (composite) walk(sel.selections, inner.name, [...path, sel.alias]);
      } else if (sel.kind === 'inline') {
        const on = sel.on || typeName;
        if (!types[on] || !types[on].fields) errors.push({ path, extensions: { code: 'undefinedType', typeName: on }, message: 'No such type ' + on + ", so it can't be a fragment condition" });
        else walk(sel.selections, on, [...path, '... on ' + on]);
      } else {
        const frag = doc.fragments.get(sel.name);
        if (!frag) errors.push({ path, extensions: { code: 'undefinedFragment', fragmentName: sel.name }, message: 'Fragment ' + sel.name + ' was used, but not defined' });
        else if (!seenFragments.has(sel.name)) {
          seenFragments.add(sel.name);
          if (!types[frag.on] || !types[frag.on].fields) errors.push({ path, extensions: { code: 'undefinedType', typeName: frag.on }, message: 'No such type ' + frag.on + ", so it can't be a fragment condition" });
          else walk(frag.selections, frag.on, ['fragment ' + sel.name]);
        }
      }
    }
  };
  const root = op.type === 'mutation' ? 'Mutation' : 'Query';
  walk(op.selections, root, [op.type + (op.name ? ' ' + op.name : '')]);
  return errors;
}

// ---- execution
function valueOf(node, vars) {
  switch (node.kind) {
    case 'var':
      return vars[node.v];
    case 'list':
      return node.v.map((x) => valueOf(x, vars));
    case 'obj': {
      const out = {};
      for (const [k, v] of node.v) out[k] = valueOf(v, vars);
      return out;
    }
    default:
      return node.v;
  }
}

function execute(doc, op, variables, ctx) {
  const vars = {};
  for (const v of op.variables) {
    if (variables && variables[v.name] !== undefined) vars[v.name] = variables[v.name];
    else if (v.def !== undefined) vars[v.name] = valueOf(v.def, {});
  }
  const included = (dirs) => {
    for (const d of dirs) {
      const cond = d.args.find((a) => a[0] === 'if');
      const val = cond ? valueOf(cond[1], vars) : true;
      if (d.name === 'skip' && val === true) return false;
      if (d.name === 'include' && val === false) return false;
    }
    return true;
  };
  const applies = (on, typeName) => !on || on === typeName || (types[on] && types[on].possible && types[on].possible.includes(typeName));
  const collect = (selections, typeName, out) => {
    for (const sel of selections) {
      if (!included(sel.directives)) continue;
      if (sel.kind === 'field') {
        const prior = out.get(sel.alias);
        if (prior) {
          if (sel.selections) prior.selections = (prior.selections || []).concat(sel.selections);
        } else out.set(sel.alias, { name: sel.name, args: sel.args, selections: sel.selections });
      } else if (sel.kind === 'inline') {
        if (applies(sel.on, typeName)) collect(sel.selections, typeName, out);
      } else {
        const frag = doc.fragments.get(sel.name);
        if (frag && applies(frag.on, typeName)) collect(frag.selections, typeName, out);
      }
    }
    return out;
  };
  const complete = (value, typeText, selections) => {
    if (value === null || value === undefined) return null;
    if (typeText.endsWith('!')) typeText = typeText.slice(0, -1);
    if (typeText.startsWith('[')) {
      const inner = typeText.slice(1, -1);
      return Array.isArray(value) ? value.map((v) => complete(v, inner, selections)) : null;
    }
    const type = types[typeText];
    if (!type || !type.fields || !selections) return value;
    const concrete = type.kind === 'OBJECT' ? typeText : runtimeType(value) || typeText;
    return fieldsOf(value, concrete, selections);
  };
  const resolveField = (src, typeName, fld) => {
    if (fld.name === '__typename') return typeName;
    const def = (types[typeName].fields || {})[fld.name];
    if (!def) return null;
    const args = {};
    for (const [k, v] of fld.args) args[k] = valueOf(v, vars);
    const raw = def.resolve ? def.resolve(src, args, ctx) : src[fld.name];
    return complete(raw, def.type, fld.selections);
  };
  const fieldsOf = (src, typeName, selections) => {
    const out = {};
    for (const [alias, fld] of collect(selections, typeName, new Map())) out[alias] = resolveField(src, typeName, fld);
    return out;
  };
  const rootName = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = {};
  const errors = [];
  for (const [alias, fld] of collect(op.selections, rootName, new Map())) {
    try {
      data[alias] = resolveField({}, rootName, fld);
    } catch (e) {
      data[alias] = null;
      const status = e instanceof ApiError ? e.status : 500;
      let message = String((e && e.message) || e);
      if (e instanceof ApiError && Array.isArray(e.extra) && e.extra[0] && e.extra[0].message) message = e.extra[0].message;
      errors.push({ type: status === 404 ? 'NOT_FOUND' : status === 500 ? 'INTERNAL' : 'UNPROCESSABLE', path: [alias], locations: [{ line: 1, column: 1 }], message });
    }
  }
  return errors.length ? { data, errors } : { data };
}

function runOne(req, ctx) {
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.query !== 'string' || req.query.trim() === '') {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  let doc;
  try {
    doc = parseDocument(req.query);
  } catch (e) {
    return { errors: [{ message: String(e.message || e), locations: [{ line: 1, column: 1 }] }] };
  }
  let op = doc.operations[0];
  if (typeof req.operationName === 'string' && req.operationName !== '') {
    op = doc.operations.find((o) => o.name === req.operationName);
    if (!op) return { errors: [{ message: 'No operation named "' + req.operationName + '"' }] };
  } else if (doc.operations.length > 1) return { errors: [{ message: 'An operation name is required' }] };
  if (op.type === 'subscription') return { errors: [{ message: 'Subscriptions are not served' }] };
  const problems = validate(doc, op);
  if (problems.length) return { errors: problems.map((p) => ({ ...p, locations: [{ line: 1, column: 1 }] })) };
  const variables = req.variables && typeof req.variables === 'object' ? req.variables : {};
  return execute(doc, op, variables, ctx);
}

export function handleGraphql(ctx) {
  let parsed;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' }) };
  }
  const out = Array.isArray(parsed) ? parsed.map((r) => runOne(r, ctx)) : runOne(parsed, ctx);
  return { status: 200, body: JSON.stringify(out) };
}
