import fsDefault from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GITHUB, SERVICES, REPOS_ROOT, DASHBOARD_DIR, parseMinPrApprover } from './config.mjs';
import { createCredentialStore, credentialIdentity } from './credentials.mjs';
import { loadEnvFile } from './env.mjs';

const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const fault = (code, errors = [], status = 422) =>
  Object.assign(new Error(code), { code, errors, status });
const fieldError = (field, code, message) => ({ field, code, message });
const editable = (input = {}) => ({
  github: input.github && {
    api: input.github.api,
    org: input.github.org,
    repos: clone(input.github.repos),
    maxResults: input.github.maxResults,
  },
  jira: input.jira && {
    baseUrl:
      typeof input.jira.baseUrl === 'string'
        ? input.jira.baseUrl.trim().replace(/\/+$/, '')
        : input.jira.baseUrl,
    email: input.jira.email,
    sprintField: input.jira.sprintField,
    pointsField: input.jira.pointsField,
  },
  local: input.local && {
    root: input.local.root,
    services: Array.isArray(input.local.services)
      ? input.local.services.map(
          (service) =>
            service && {
              id: service.id,
              label: service.label,
              dir: service.dir,
              command: clone(service.command),
              port: service.port,
            },
        )
      : input.local.services,
  },
  minPrApprover: input.minPrApprover,
});

export function createSettingsStore(options = {}) {
  const home = options.paths?.home || os.homedir();
  const paths = {
    home,
    root: REPOS_ROOT,
    dashboardDir: DASHBOARD_DIR,
    settings: path.join(home, '.config/dev-dashboard/settings.json'),
    githubToken: path.join(home, '.config/github/token'),
    jiraToken: path.join(home, '.config/jira/token'),
    ...options.paths,
  };
  const fs = options.fs || fsDefault;
  const env = options.env || process.env;
  const fetchRemote = options.fetch || ((...args) => globalThis.fetch(...args));
  const credentials = createCredentialStore({ paths, fs });
  const listeners = new Set();
  let record = null;
  let errors = [fieldError('settings', 'SETUP_REQUIRED', 'Complete Settings to continue.')];
  let connection = { status: 'unknown' };
  let queue = Promise.resolve();
  let initialized = false;
  let lifecycle = null;
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const captureTokens = () => {
    const captured = credentials.capture();
    return {
      captured,
      values: { githubToken: captured.github.token, jiraToken: captured.jira.token },
    };
  };
  const identity = (candidate, values, name) =>
    JSON.stringify([candidate[name], credentialIdentity(values[`${name}Token`])]);
  const accepted = (candidate, values, name) =>
    candidate?.validation?.[name]?.accepted === true &&
    candidate.validation[name].identity === identity(candidate, values, name);
  function publish(
    candidate,
    values,
    issues,
    state = candidate?.validation?.connection || { status: 'unknown' },
  ) {
    record = candidate;
    errors = issues;
    connection = { ...state, state: state.status };
    for (const listener of listeners) {
      try {
        listener(getSetupStatus());
      } catch {}
    }
  }
  async function inspect(candidate, values) {
    const issues = [];
    const add = (field, message, code = 'INVALID_FIELD') =>
      issues.push(fieldError(field, code, message));
    if (
      candidate?.schemaVersion !== 1 ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      !['fresh', 'legacy'].includes(candidate.origin) ||
      !candidate.validation ||
      typeof candidate.validation !== 'object' ||
      Array.isArray(candidate.validation)
    )
      add('settings', 'Repair the settings record.', 'INVALID_SCHEMA');
    const github = candidate?.github;
    if (github?.api !== 'https://api.github.com') add('github.api', 'Use the public GitHub API.');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(github?.org || ''))
      add('github.org', 'Enter a GitHub owner.');
    if (
      !Array.isArray(github?.repos) ||
      !github.repos.length ||
      github.repos.some(
        (repo) =>
          typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(repo) || ['.', '..'].includes(repo),
      ) ||
      new Set(github.repos).size !== github.repos.length
    )
      add('github.repos', 'Enter unique repository names.');
    if (
      !Number.isSafeInteger(github?.maxResults) ||
      github.maxResults < 1 ||
      github.maxResults > 100
    )
      add('github.maxResults', 'Enter a result limit from 1 to 100.');
    if (!values.githubToken)
      add('credentials.githubToken', 'Provide a readable GitHub token.', 'CREDENTIAL_REQUIRED');
    const jira = candidate?.jira;
    try {
      const url = new URL(jira?.baseUrl);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      add('jira.baseUrl', 'Enter an HTTP(S) Jira URL without credentials, query or fragment.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(jira?.email || ''))
      add('jira.email', 'Enter a valid Jira email.');
    for (const field of ['sprintField', 'pointsField'])
      if (!/^customfield_\d+$/.test(jira?.[field] || ''))
        add(`jira.${field}`, 'Enter a customfield identifier.');
    if (!values.jiraToken)
      add('credentials.jiraToken', 'Provide a readable Jira token.', 'CREDENTIAL_REQUIRED');
    if (!Number.isSafeInteger(candidate?.minPrApprover) || candidate.minPrApprover < 1)
      add('minPrApprover', 'Enter a positive approval count.');
    const local = candidate?.local;
    let rootValid = typeof local?.root === 'string' && path.isAbsolute(local.root);
    if (rootValid) {
      try {
        rootValid = fs.statSync(local.root).isDirectory();
        fs.accessSync(local.root, fs.constants.R_OK | fs.constants.X_OK);
      } catch {
        rootValid = false;
      }
    }
    if (!rootValid) add('local.root', 'Enter a readable absolute repository root.');
    if (!Array.isArray(local?.services) || !local.services.length)
      add('local.services', 'Configure at least one service.');
    const ids = new Set();
    const ports = new Set();
    for (const [index, service] of (Array.isArray(local?.services)
      ? local.services
      : []
    ).entries()) {
      const prefix = `local.services.${index}`;
      if (!service || typeof service !== 'object') {
        add(prefix, 'Enter a service definition.');
        continue;
      }
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(service.id || '') ||
        ['__proto__', 'constructor', 'prototype'].includes(service.id) ||
        ids.has(service.id)
      )
        add(`${prefix}.id`, 'Enter a unique safe service ID.');
      ids.add(service.id);
      if (typeof service.label !== 'string' || !service.label.trim())
        add(`${prefix}.label`, 'Enter a service label.');
      if (typeof service.dir !== 'string' || !service.dir.trim())
        add(`${prefix}.dir`, 'Enter a working directory.');
      else if (rootValid) {
        try {
          const cwd = path.resolve(local.root, service.dir);
          if (!fs.statSync(cwd).isDirectory()) throw new Error();
          fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
        } catch {
          add(`${prefix}.dir`, 'Working directory must be readable.');
        }
      }
      if (
        !Array.isArray(service.command) ||
        !service.command.length ||
        service.command.some((arg) => typeof arg !== 'string' || !arg.trim() || arg.includes('\0'))
      )
        add(`${prefix}.command`, 'Enter a nonempty command argument list.');
      if (
        service.port !== null &&
        (!Number.isInteger(service.port) ||
          service.port < 1 ||
          service.port > 65535 ||
          ports.has(service.port))
      )
        add(`${prefix}.port`, 'Enter a unique port from 1 to 65535, or null.');
      if (typeof service.port === 'number') ports.add(service.port);
      if (rootValid && !issues.some((issue) => issue.field.startsWith(prefix))) {
        try {
          const inspector =
            options.runtimeInspector || (await import('./manager.mjs')).inspectRuntime;
          const result = await inspector(service, local);
          if (!result?.ok)
            add(
              `${prefix}.command`,
              'Install the configured executable and exact Node runtime.',
              'INVALID_RUNTIME',
            );
        } catch {
          add(
            `${prefix}.command`,
            'Install the configured executable and exact Node runtime.',
            'INVALID_RUNTIME',
          );
        }
      }
    }
    return issues;
  }
  function getSetupStatus() {
    const issues = [...errors];
    const current = captureTokens().values;
    for (const name of ['github', 'jira']) {
      if (!accepted(record, current, name))
        issues.push(
          fieldError(name, 'VALIDATION_REQUIRED', 'Validate this integration in Settings.'),
        );
    }
    return clone({
      ready: !!record && issues.length === 0,
      errors: issues,
      revision: record?.revision || 0,
      origin: record?.origin || 'fresh',
      connection: { ...connection, state: connection.status },
    });
  }
  function getPublicSettings() {
    const captured = credentials.capture();
    const fields = editable(record || {});
    if (fields.github && !Array.isArray(fields.github.repos)) fields.github.repos = [];
    if (fields.local)
      fields.local.services = Array.isArray(fields.local.services)
        ? fields.local.services.filter((service) => service && typeof service === 'object')
        : [];
    return clone({
      schemaVersion: 1,
      revision: record?.revision || 0,
      origin: record?.origin || 'fresh',
      github: fields.github || {},
      jira: fields.jira || {},
      local: fields.local || { root: paths.root, services: [] },
      minPrApprover: record?.minPrApprover || 1,
      credentials: Object.fromEntries(
        ['github', 'jira'].map((name) => [
          name,
          { present: !!captured[name].token, source: captured[name].source },
        ]),
      ),
      setup: getSetupStatus(),
    });
  }
  function getSnapshot() {
    return freeze(clone({ ...record, credentials: captureTokens().values }));
  }
  function checkPersistedRevision() {
    try {
      const persisted = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
      if (persisted.revision !== record?.revision) throw fault('REVISION_CONFLICT', [], 409);
    } catch (error) {
      if (error.code === 'REVISION_CONFLICT') throw error;
      if (record) throw fault('REVISION_CONFLICT', [], 409);
    }
  }
  function persist(candidate, replacements = {}) {
    const staged = [];
    const backups = [];
    try {
      for (const name of ['github', 'jira']) {
        if (!replacements[`${name}Token`]) continue;
        const file = paths[`${name}Token`];
        const previous = credentials.capture()[name];
        if (previous.unsafe) throw fault('UNSAFE_CREDENTIAL');
        const exists = fs.existsSync(file);
        backups.push({ file, contents: exists ? fs.readFileSync(file) : null });
        staged.push({ file, temporary: credentials.stage(file, replacements[`${name}Token`]) });
      }
      staged.push({
        file: paths.settings,
        temporary: credentials.stage(paths.settings, JSON.stringify(candidate, null, 2) + '\n'),
      });
      for (const entry of staged) fs.renameSync(entry.temporary, entry.file);
    } catch {
      let restored = true;
      for (const backup of backups.reverse()) {
        try {
          if (backup.contents === null) fs.rmSync(backup.file, { force: true });
          else fs.renameSync(credentials.stage(backup.file, backup.contents), backup.file);
        } catch {
          restored = false;
        }
      }
      if (!restored)
        errors = [
          fieldError('settings', 'REPAIR_REQUIRED', 'Credential persistence requires repair.'),
        ];
      throw fault('PERSISTENCE_FAILED', [], 503);
    } finally {
      for (const entry of staged) {
        try {
          fs.rmSync(entry.temporary, { force: true });
        } catch {}
      }
    }
  }
  const legacyValues = () => loadEnvFile({ directory: paths.dashboardDir, env, fs }) || env;
  const missingReplacements = (captured, source) => {
    const replacements = {};
    const github = String(source.GH_TOKEN || '').trim() || String(source.GITHUB_TOKEN || '').trim();
    const jira =
      String(source.JIRA_TOKEN || '').trim() || String(source.JIRA_API_TOKEN || '').trim();
    for (const [name, value] of [
      ['github', github],
      ['jira', jira],
    ]) {
      if (captured.captured[name].source === 'missing' && value)
        replacements[`${name}Token`] = value;
    }
    return replacements;
  };
  async function probes(candidate, values, names, revalidation = false) {
    const outcomes = {};
    const deadline = Date.now() + 30000;
    for (const name of names) {
      let status = 'accepted';
      const issues = [];
      const headers =
        name === 'github'
          ? { Authorization: `Bearer ${values.githubToken}`, Accept: 'application/vnd.github+json' }
          : {
              Authorization: `Basic ${Buffer.from(`${candidate.jira.email}:${values.jiraToken}`).toString('base64')}`,
              Accept: 'application/json',
            };
      const request = async (url, init = {}, check) => {
        try {
          if (Date.now() >= deadline) throw new Error();
          const response = await fetchRemote(url, {
            ...init,
            headers: { ...headers, ...init.headers },
            redirect: 'error',
            signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
          });
          if (!response.ok) {
            const rateLimited =
              response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
            let permissionDenied = false;
            if (response.status === 403 && !rateLimited) {
              try {
                const body = await response.json();
                permissionDenied =
                  /permission|not accessible|forbidden|access denied|insufficient scope/i.test(
                    String(body.message || body.error || ''),
                  );
              } catch {}
            }
            const definitive =
              [400, 401, 404, 422].includes(response.status) ||
              (response.status === 403 && !rateLimited && (permissionDenied || !revalidation));
            if (definitive) status = 'invalid';
            else if (status !== 'invalid') status = 'degraded';
          } else {
            const body = await response.json();
            if (url.endsWith('/graphql') && body.errors?.length) {
              const definitive = body.errors.some((error) =>
                [
                  'FORBIDDEN',
                  'UNAUTHORIZED',
                  'NOT_FOUND',
                  'BAD_USER_INPUT',
                  'GRAPHQL_VALIDATION_FAILED',
                ].includes(error.type || error.extensions?.code),
              );
              if (definitive) status = 'invalid';
              else if (status !== 'invalid') status = 'degraded';
            } else if (check && !check(body)) status = 'invalid';
          }
        } catch {
          if (status !== 'invalid') status = 'degraded';
        }
      };
      if (name === 'github') {
        const base = candidate.github.api;
        await request(`${base}/user`, {}, (body) => !!body.login);
        for (const repo of candidate.github.repos) {
          await request(
            `${base}/repos/${candidate.github.org}/${repo}`,
            {},
            (body) => body.permissions?.pull !== false && !!body.name,
          );
          await request(
            `${base}/graphql`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query:
                  'query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){name pullRequests(first:1){nodes{number}}}}',
                variables: { owner: candidate.github.org, name: repo },
              }),
            },
            (body) => !body.errors?.length && !!body.data?.viewer?.login && !!body.data?.repository,
          );
        }
      } else {
        const base = candidate.jira.baseUrl.replace(/\/$/, '');
        await request(`${base}/rest/api/3/myself`, {}, (body) => !!body.accountId);
        await request(
          `${base}/rest/api/3/search/jql?jql=${encodeURIComponent('assignee = currentUser()')}&maxResults=1`,
          {},
          (body) => Array.isArray(body.issues),
        );
        await request(
          `${base}/rest/api/3/field`,
          {},
          (body) =>
            Array.isArray(body) &&
            body.some(
              (field) =>
                field.id === candidate.jira.sprintField &&
                field.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint',
            ) &&
            body.some(
              (field) => field.id === candidate.jira.pointsField && field.schema?.type === 'number',
            ),
        );
      }
      if (status !== 'accepted')
        issues.push(
          fieldError(
            name,
            status === 'invalid' ? 'VALIDATION_FAILED' : 'VALIDATION_UNAVAILABLE',
            status === 'invalid'
              ? 'Check authentication, permissions and configured fields.'
              : 'Connection unavailable; retry validation.',
          ),
        );
      outcomes[name] = { status, issues };
    }
    return outcomes;
  }
  async function initialize() {
    return serialize(async () => {
      if (initialized) return getPublicSettings();
      try {
        let existing;
        try {
          existing = fs.readFileSync(paths.settings, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (existing !== undefined) {
          const candidate = JSON.parse(existing);
          const captured = captureTokens();
          let values = captured.values;
          let issues = await inspect(candidate, values);
          if (
            candidate.schemaVersion === 1 &&
            candidate.origin === 'legacy' &&
            !issues.some((issue) => issue.code === 'INVALID_SCHEMA') &&
            Object.values(captured.captured).some((entry) => entry.source === 'missing')
          ) {
            const replacements = missingReplacements(captured, legacyValues());
            if (Object.keys(replacements).length) {
              values = { ...values, ...replacements };
              issues = await inspect(candidate, values);
              if (
                candidate.revision === 1 &&
                !issues.length &&
                !candidate.validation.github &&
                !candidate.validation.jira
              ) {
                for (const name of ['github', 'jira'])
                  candidate.validation[name] = {
                    accepted: true,
                    identity: identity(candidate, values, name),
                    provenance: 'legacy-unverified',
                  };
                candidate.validation.connection = { status: 'legacy-unverified' };
              }
              persist(candidate, replacements);
            }
          }
          publish(candidate, values, issues);
        } else {
          let legacyEnv = false;
          try {
            fs.statSync(path.join(paths.dashboardDir, '.env'));
            legacyEnv = true;
          } catch {}
          const source = legacyValues();
          const captured = captureTokens();
          const legacy =
            legacyEnv ||
            [
              'GH_TOKEN',
              'GITHUB_TOKEN',
              'JIRA_API_TOKEN',
              'JIRA_TOKEN',
              'JIRA_EMAIL',
              'JIRA_BASE_URL',
              'JIRA_SPRINT_FIELD',
              'JIRA_POINTS_FIELD',
              'MIN_PR_APPROVER',
            ].some((key) => String(source[key] || '').trim()) ||
            captured.values.githubToken ||
            captured.values.jiraToken;
          const replacements = missingReplacements(captured, source);
          const values = { ...captured.values, ...replacements };
          const candidate = {
            schemaVersion: 1,
            revision: 1,
            origin: legacy ? 'legacy' : 'fresh',
            github: clone(GITHUB),
            jira: {
              baseUrl: String(source.JIRA_BASE_URL || '')
                .trim()
                .replace(/\/$/, ''),
              email: String(source.JIRA_EMAIL || '').trim(),
              sprintField: String(source.JIRA_SPRINT_FIELD || 'customfield_10020').trim(),
              pointsField: String(source.JIRA_POINTS_FIELD || 'customfield_10058').trim(),
            },
            local: { root: paths.root, services: clone(Object.values(SERVICES)) },
            minPrApprover: parseMinPrApprover(source.MIN_PR_APPROVER),
            validation: {},
          };
          const issues = await inspect(candidate, values);
          if (legacy && !issues.length) {
            for (const name of ['github', 'jira'])
              candidate.validation[name] = {
                accepted: true,
                identity: identity(candidate, values, name),
                provenance: 'legacy-unverified',
              };
            candidate.validation.connection = { status: 'legacy-unverified' };
          }
          persist(candidate, replacements);
          publish(candidate, values, issues);
        }
        initialized = true;
      } catch {
        publish(null, { githubToken: '', jiraToken: '' }, [
          fieldError(
            'settings',
            'REPAIR_REQUIRED',
            'Settings could not be loaded or persisted; repair and retry.',
          ),
        ]);
      }
      return getPublicSettings();
    });
  }
  function save(input) {
    return serialize(async () => {
      const operation = async () => {
        if (input?.expectedRevision !== (record?.revision || 0))
          throw fault('REVISION_CONFLICT', [], 409);
        checkPersistedRevision();
        const captured = captureTokens();
        if (Object.values(captured.captured).some((entry) => entry.unsafe))
          throw fault('UNSAFE_CREDENTIAL');
        const replacements = {};
        for (const name of ['githubToken', 'jiraToken'])
          if (typeof input.credentials?.[name] === 'string' && input.credentials[name].trim())
            replacements[name] = input.credentials[name].trim();
        const values = { ...captured.values, ...replacements };
        const candidate = {
          schemaVersion: 1,
          revision: (record?.revision || 0) + 1,
          origin: record?.origin || 'fresh',
          ...editable(input),
          validation: clone(record?.validation || {}),
        };
        const issues = await inspect(candidate, values);
        if (issues.length && (getSetupStatus().ready || Object.keys(replacements).length))
          throw fault('INVALID_SETTINGS', issues);
        if (!issues.length) {
          const names = ['github', 'jira'].filter((name) => !accepted(candidate, values, name));
          const outcomes = await probes(candidate, values, names);
          const failures = Object.values(outcomes).flatMap((outcome) => outcome.issues);
          if (failures.length)
            throw fault(
              failures.some((issue) => issue.code === 'VALIDATION_FAILED')
                ? 'VALIDATION_FAILED'
                : 'VALIDATION_UNAVAILABLE',
              failures,
              failures.some((issue) => issue.code === 'VALIDATION_FAILED') ? 422 : 503,
            );
          for (const name of names)
            candidate.validation[name] = {
              accepted: true,
              identity: identity(candidate, values, name),
              provenance: 'verified',
            };
          if (names.length) candidate.validation.connection = { status: 'verified' };
        }
        if (input.expectedRevision !== (record?.revision || 0))
          throw fault('REVISION_CONFLICT', [], 409);
        checkPersistedRevision();
        if (JSON.stringify(captureTokens().values) !== JSON.stringify(captured.values))
          throw fault('REVISION_CONFLICT', [], 409);
        if (Array.isArray(candidate.local?.services)) {
          lifecycle?.check?.(candidate.local);
          if (lifecycle && !lifecycle.check) await lifecycle.apply?.(candidate.local);
        }
        const oldSettings = fs.existsSync(paths.settings) ? fs.readFileSync(paths.settings) : null;
        const oldTokens = captured.values;
        persist(candidate, replacements);
        try {
          if (lifecycle?.check && Array.isArray(candidate.local?.services))
            await lifecycle.apply?.(candidate.local);
        } catch {
          try {
            for (const name of Object.keys(replacements)) {
              const file = paths[name];
              if (captured.captured[name.replace('Token', '')].source === 'missing')
                fs.rmSync(file, { force: true });
              else fs.renameSync(credentials.stage(file, oldTokens[name]), file);
            }
            if (oldSettings === null) fs.rmSync(paths.settings, { force: true });
            else fs.renameSync(credentials.stage(paths.settings, oldSettings), paths.settings);
          } catch {
            errors = [
              fieldError('settings', 'REPAIR_REQUIRED', 'Settings reconciliation requires repair.'),
            ];
          }
          throw fault('PERSISTENCE_FAILED', [], 503);
        }
        publish(candidate, values, issues);
        return getPublicSettings();
      };
      return lifecycle?.run ? lifecycle.run(operation) : operation();
    });
  }
  function validate({ expectedRevision } = {}) {
    return serialize(async () => {
      const operation = async () => {
        if (expectedRevision !== undefined && expectedRevision !== (record?.revision || 0))
          throw fault('REVISION_CONFLICT', [], 409);
        checkPersistedRevision();
        const values = captureTokens().values;
        const issues = await inspect(record, values);
        if (issues.length) {
          publish(record, values, issues);
          return getPublicSettings();
        }
        const candidate = clone(record);
        const outcomes = await probes(candidate, values, ['github', 'jira'], true);
        if (JSON.stringify(captureTokens().values) !== JSON.stringify(values))
          throw fault('REVISION_CONFLICT', [], 409);
        checkPersistedRevision();
        for (const name of ['github', 'jira']) {
          if (outcomes[name].status === 'accepted')
            candidate.validation[name] = {
              accepted: true,
              identity: identity(candidate, values, name),
              provenance: 'verified',
            };
          else if (outcomes[name].status === 'invalid')
            candidate.validation[name] = { accepted: false };
        }
        candidate.validation.connection = {
          status: Object.values(outcomes).some((outcome) => outcome.status === 'degraded')
            ? 'degraded'
            : Object.values(outcomes).some((outcome) => outcome.status === 'invalid')
              ? 'invalid'
              : 'verified',
          errors: Object.values(outcomes).flatMap((outcome) => outcome.issues),
        };
        candidate.revision += 1;
        const becomingReady = ['github', 'jira'].every((name) => accepted(candidate, values, name));
        if (becomingReady) {
          lifecycle?.check?.(candidate.local);
          if (lifecycle && !lifecycle.check) await lifecycle.apply?.(candidate.local);
        }
        const previousSettings = fs.readFileSync(paths.settings);
        persist(candidate);
        if (becomingReady && lifecycle?.check) {
          try {
            await lifecycle.apply?.(candidate.local);
          } catch {
            try {
              fs.renameSync(credentials.stage(paths.settings, previousSettings), paths.settings);
            } catch {
              errors = [
                fieldError(
                  'settings',
                  'REPAIR_REQUIRED',
                  'Settings reconciliation requires repair.',
                ),
              ];
            }
            throw fault('PERSISTENCE_FAILED', [], 503);
          }
        }
        publish(candidate, values, issues);
        return getPublicSettings();
      };
      return lifecycle?.run ? lifecycle.run(operation) : operation();
    });
  }
  function refreshReadiness() {
    return serialize(async () => {
      const operation = async () => {
        const wasReady = getSetupStatus().ready;
        const values = captureTokens().values;
        const issues = await inspect(record, values);
        const restoringReady =
          !wasReady &&
          !issues.length &&
          ['github', 'jira'].every((name) => accepted(record, values, name));
        if (restoringReady && lifecycle) {
          try {
            lifecycle.check?.(record.local);
            await lifecycle.apply?.(record.local);
          } catch {
            publish(record, values, [
              fieldError(
                'local.services',
                'RECONCILIATION_REQUIRED',
                'Saved services could not be restored; retry after resolving the service conflict.',
              ),
            ]);
            return getSetupStatus();
          }
        }
        publish(record, values, issues);
        return getSetupStatus();
      };
      return lifecycle?.run ? lifecycle.run(operation) : operation();
    });
  }
  return {
    initialize,
    getSnapshot,
    getPublicSettings,
    getSetupStatus,
    save,
    validate,
    refreshReadiness,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindLifecycle(value) {
      lifecycle = value;
    },
  };
}

export const settingsStore = createSettingsStore();
export const getSettingsStore = () => settingsStore;

export function captureConfiguration(snapshot) {
  if (snapshot) return snapshot;
  const current = settingsStore.getSnapshot();
  if (current.revision) return current;
  return freeze({
    github: clone(GITHUB),
    jira: {
      baseUrl: (process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, ''),
      email: (process.env.JIRA_EMAIL || '').trim(),
      sprintField: (process.env.JIRA_SPRINT_FIELD || 'customfield_10020').trim(),
      pointsField: (process.env.JIRA_POINTS_FIELD || 'customfield_10058').trim(),
    },
    local: { root: REPOS_ROOT, services: clone(Object.values(SERVICES)) },
    minPrApprover: parseMinPrApprover(process.env.MIN_PR_APPROVER),
    credentials: {
      githubToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
      jiraToken: (process.env.JIRA_TOKEN || '').trim(),
    },
  });
}
