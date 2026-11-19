import './setup';
import * as index from '../index';
import * as core from '@actions/core';
import * as github from '@actions/github';

jest.mock('@actions/github', () => ({ getOctokit: jest.fn(), context: {} }));

// In-memory GitHub: refs are atomic and Contents writes create immutable
// snapshots. Reusing live content as the layout base therefore fails here.
function fixture(files: any[], initial: Record<string, string>, source: Record<string, string>) {
  const folder = 'vcluster_versioned_docs/version-0.37.0';
  const branch = 'backport/vcluster-to-0.37-pr-123';
  const snapshots = new Map<string, Record<string, string>>([['original-base', { ...initial }]]);
  const refs = new Map<string, string>([['heads/main', 'original-base']]);
  const prs: any[] = [];
  let serial = 0;
  const missing = () => Object.assign(new Error('Not found'), { status: 404 });
  const commit = (name: string, path: string, content?: string) => {
    const next = { ...snapshots.get(refs.get(`heads/${name}`)!)! };
    if (content === undefined) delete next[path]; else next[path] = content;
    const sha = `write-${++serial}`;
    snapshots.set(sha, next);
    refs.set(`heads/${name}`, sha);
  };
  const api = {
    paginate: jest.fn().mockResolvedValue(files),
    rest: {
      git: {
        getRef: jest.fn(async ({ ref }: any) => {
          if (!refs.has(ref)) throw missing();
          return { data: { object: { sha: refs.get(ref) } } };
        }),
        createRef: jest.fn(async ({ ref, sha }: any) => {
          const key = ref.replace(/^refs\//, '');
          if (refs.has(key)) throw Object.assign(new Error('Reference already exists'), { status: 422 });
          refs.set(key, sha);
          return {};
        }),
        deleteRef: jest.fn(async ({ ref }: any) => {
          if (!refs.delete(ref)) throw missing();
          return {};
        })
      },
      repos: {
        get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
        getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'pre-merge' }] } }),
        compareCommits: jest.fn(async ({ base, head }: any) => {
          expect(base).toBe('main');
          const current = snapshots.get(refs.get(`heads/${head}`)!)!;
          return { data: {
            merge_base_commit: { sha: 'original-base' },
            files: [...new Set([...Object.keys(initial), ...Object.keys(current)])]
              .filter(path => initial[path] !== current[path]).map(filename => ({ filename }))
          } };
        }),
        getContent: jest.fn(async ({ path, ref }: any) => {
          const tree = ref === 'merge-sha' ? source : ref === 'pre-merge' ? source :
            snapshots.get(refs.get(`heads/${ref}`) || ref);
          if (!tree) throw new Error(`Unknown ref ${ref}`);
          if (Object.prototype.hasOwnProperty.call(tree, path)) return { data: { content: Buffer.from(tree[path]).toString('base64'), sha: `blob-${tree[path]}` } };
          if (Object.keys(tree).some(p => p.startsWith(`${path}/`))) return { data: [] };
          throw missing();
        }),
        createOrUpdateFileContents: jest.fn(async ({ branch, path, content }: any) => {
          commit(branch, path, Buffer.from(content, 'base64').toString());
          return {};
        }),
        deleteFile: jest.fn(async ({ branch, path }: any) => { commit(branch, path); return {}; })
      },
      pulls: {
        list: jest.fn(async ({ state }: any) => ({ data: state === 'open' ? prs : [] })),
        create: jest.fn(async (params: any) => {
          const pr = { ...params, number: prs.length + 456, base: { ref: params.base } };
          prs.push(pr);
          return { data: pr };
        })
      },
      issues: {
        addLabels: jest.fn().mockResolvedValue({}),
        createComment: jest.fn().mockResolvedValue({ data: { html_url: 'https://example.test/comment' } })
      }
    }
  };
  (core.getInput as jest.Mock).mockReturnValue('fake-token');
  (github.getOctokit as jest.Mock).mockReturnValue(api);
  Object.assign(github.context, {
    repo: { owner: 'test', repo: 'docs' },
    payload: {
      action: 'closed', repository: { default_branch: 'main' },
      pull_request: { number: 123, merged: true, merge_commit_sha: 'merge-sha', commits: 1,
        title: 'Docs', labels: [{ name: 'backport-v0.37' }] }
    }
  });
  return { api, refs, snapshots, prs, folder, branch, current: () => snapshots.get(refs.get(`heads/${branch}`)!)! };
}

const folder = 'vcluster_versioned_docs/version-0.37.0';
const added = ['a', 'b'].map(name => ({ filename: `vcluster/${name}.mdx`, status: 'added' }));
const initial = { [`${folder}/keep.mdx`]: 'keep' };
const source = { 'vcluster/a.mdx': 'A', 'vcluster/b.mdx': 'B' };

beforeEach(() => jest.clearAllMocks());

test('retry completes mid-write failure and opens exactly one PR', async () => {
  const f = fixture(added, initial, source);
  const write = f.api.rest.repos.createOrUpdateFileContents;
  const implementation = write.getMockImplementation()!;
  write.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('write outage'));
  await index.run();
  expect(f.prs).toHaveLength(0);
  expect(f.current()[`${folder}/a.mdx`]).toBe('A');
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('failed for 1 file(s)'));
  await index.run();
  await index.run();
  expect(f.current()[`${folder}/b.mdx`]).toBe('B');
  expect(f.prs).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(3); // a, failed b, resumed b
  expect(f.api.rest.issues.createComment).not.toHaveBeenCalled();
});

test('retry after PR creation fails opens one PR without rewriting completed files', async () => {
  const f = fixture(added, initial, source);
  f.api.rest.pulls.create.mockRejectedValueOnce(new Error('PR outage'));
  await index.run();
  expect(f.current()[`${folder}/b.mdx`]).toBe('B');
  expect(f.prs).toHaveLength(0);
  const writes = f.api.rest.repos.createOrUpdateFileContents.mock.calls.length;
  // Main can advance independently; layout and prior changes still use merge base.
  f.snapshots.set('advanced-main', { ...initial, unrelated: 'new' });
  f.refs.set('heads/main', 'advanced-main');
  await index.run();
  expect(f.prs).toHaveLength(1);
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(writes);
  expect(f.api.rest.issues.createComment).not.toHaveBeenCalled();
});

test('resume keeps original folder layout after deleting its last file', async () => {
  const files = [{ filename: 'vcluster/sub/old.mdx', status: 'removed' },
    { filename: 'vcluster/sub/new.mdx', status: 'added' }];
  const f = fixture(files, { [`${folder}/sub/old.mdx`]: 'old' }, { 'vcluster/sub/new.mdx': 'new' });
  f.api.rest.repos.createOrUpdateFileContents.mockRejectedValueOnce(new Error('write outage'));
  await index.run();
  expect(f.current()).toEqual({});
  await index.run();
  expect(f.current()).toEqual({ [`${folder}/sub/new.mdx`]: 'new' });
  expect(f.prs).toHaveLength(1);
  expect(f.api.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: `${folder}/sub`, ref: 'original-base' }));
});

test.each([false, true])('resume completes rename with prior destination, old path already deleted: %s', async removed => {
  const files = [{ filename: 'vcluster/new.mdx', previous_filename: 'vcluster/old.mdx', status: 'renamed' }];
  // Pure rename: preserve the version-specific text, rather than source bytes.
  const f = fixture(files, { [`${folder}/old.mdx`]: 'version-specific' },
    { 'vcluster/old.mdx': 'main text', 'vcluster/new.mdx': 'main text' });
  if (removed) f.api.rest.pulls.create.mockRejectedValueOnce(new Error('PR outage'));
  else f.api.rest.repos.deleteFile.mockRejectedValueOnce(new Error('delete outage'));
  await index.run();
  expect(f.current()[`${folder}/new.mdx`]).toBe('version-specific');
  await index.run();
  expect(f.current()).toEqual({ [`${folder}/new.mdx`]: 'version-specific' });
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
  expect(f.prs).toHaveLength(1);
  expect(f.api.rest.issues.createComment).not.toHaveBeenCalled();
});

test('real destination collision remains a conflict on resume', async () => {
  const f = fixture(added, { ...initial, [`${folder}/a.mdx`]: 'independent' }, source);
  f.api.rest.pulls.create.mockRejectedValueOnce(new Error('PR outage'));
  await index.run();
  await index.run();
  expect(f.current()[`${folder}/a.mdx`]).toBe('independent');
  expect(f.prs).toHaveLength(1);
  expect(f.prs[0].body).toContain(`${folder}/a.mdx`);
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
});

test.each([false, true])('two concurrent deliveries have only one writer and one PR (resuming %s)', async resuming => {
  const f = fixture(added, initial, source);
  if (resuming) f.refs.set(`heads/${f.branch}`, 'original-base');
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const implementation = f.api.rest.repos.createOrUpdateFileContents.getMockImplementation()!;
  f.api.rest.repos.createOrUpdateFileContents.mockImplementationOnce(async params => {
    entered();
    await barrier;
    return implementation(params);
  });
  const first = index.run();
  await Promise.race([writing, first.then(() => { throw new Error('delivery skipped unfinished branch'); })]);
  await index.run();
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
  expect(f.api.rest.git.deleteRef).not.toHaveBeenCalled(); // loser cannot unlock winner
  release();
  await first;
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(2);
  expect(f.prs).toHaveLength(1);
  expect(core.setFailed).not.toHaveBeenCalled();
});

test('PR lookup reaches a matching closed PR after 10,000 results', async () => {
  const f = fixture(added, initial, source);
  const unrelated = Array.from({ length: 100 }, () => ({ title: 'unrelated', body: '', base: { ref: 'main' } }));
  f.api.rest.pulls.list.mockImplementation(async ({ state, page }: any) => ({ data: state === 'open' ? [] : page <= 100 ? unrelated : [
    { number: 42, title: '[v0.37] Docs (#123)', base: { ref: 'main' } }
  ] }));
  const result = await index.checkExistingBackportPR(f.api, github.context, 'vcluster', '0.37', 123);
  expect(result.number).toBe(42);
  expect(f.api.rest.pulls.list).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed', page: 101 }));
});

test('an unrelated preexisting destination with identical bytes is still a conflict', async () => {
  const f = fixture(added, { ...initial, [`${folder}/a.mdx`]: 'A' }, source);
  await index.run();
  expect(f.prs).toHaveLength(1);
  expect(f.prs[0].body).toContain(`${folder}/a.mdx`);
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
});

test('a prior destination changed after the failed write remains a conflict', async () => {
  const f = fixture(added, initial, source);
  f.api.rest.pulls.create.mockRejectedValueOnce(new Error('PR outage'));
  await index.run();
  f.snapshots.set('edited', { ...f.current(), [`${folder}/a.mdx`]: 'manual change' });
  f.refs.set(`heads/${f.branch}`, 'edited');
  await index.run();
  expect(f.prs).toHaveLength(1);
  expect(f.prs[0].body).toContain(`${folder}/a.mdx`);
  expect(f.current()[`${folder}/a.mdx`]).toBe('manual change');
  expect(f.api.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(2);
});
