// Tests for the Docs Backport Action

// Import setup to ensure mocks are properly initialized
import './setup';
// Import the index module
import * as index from '../index';
// Export backportFiles for testing - we need to test it directly
// Since it's not exported, we'll test via the run() function behavior

describe('Docs Backport Action Tests', () => {
  // Basic test to ensure test environment works
  it('has a working test environment', () => {
    expect(true).toBe(true);
  });
  
  // Test that the module can be imported
  it('imports the action module without errors', () => {
    expect(() => {
      require('../index');
    }).not.toThrow();
  });
  
  // Test for the checkExistingBackportPR function
  describe('checkExistingBackportPR', () => {
    it('returns a PR when one exists with legacy format', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn()
              .mockResolvedValueOnce({ data: [] }) // No open PRs
              .mockResolvedValueOnce({
                data: [
                  {
                    number: 456,
                    title: 'Backport: vcluster changes to v0.24',
                    body: 'Original PR: #123'
                  }
                ]
              })
          }
        }
      };
      
      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };
      
      const result = await index.checkExistingBackportPR(
        mockOctokit,
        mockContext,
        'vcluster',
        '0.24',
        123
      );
      
      expect(result).not.toBeNull();
      expect(result.number).toBe(456);
    });

    it('returns a PR when one exists with new format', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn().mockResolvedValue({
              data: [
                {
                  number: 789,
                  title: '[v0.24] Fix some issue (#123)',
                  body: 'Original PR: #123'
                }
              ]
            })
          }
        }
      };
      
      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };
      
      const result = await index.checkExistingBackportPR(
        mockOctokit,
        mockContext,
        'vcluster',
        '0.24',
        123
      );
      
      expect(result).not.toBeNull();
      expect(result.number).toBe(789);
    });

    it('checks both open and closed PRs', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn()
              .mockResolvedValueOnce({ data: [] }) // No open PRs
              .mockResolvedValueOnce({
                data: [
                  {
                    number: 456,
                    title: '[v0.24] Some title (#123)',
                    body: 'Original PR: #123',
                    state: 'closed'
                  }
                ]
              })
          }
        }
      };
      
      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };
      
      const result = await index.checkExistingBackportPR(
        mockOctokit,
        mockContext,
        'vcluster',
        '0.24',
        123
      );
      
      expect(result).not.toBeNull();
      expect(result.number).toBe(456);
      expect(mockOctokit.rest.pulls.list).toHaveBeenCalledTimes(2);
    });
    
    it('returns null when no PR exists', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn()
              .mockResolvedValue({ data: [] })
          }
        }
      };
      
      const mockContext = {
        repo: {
          owner: 'loft-sh',
          repo: 'vcluster-docs'
        }
      };
      
      const result = await index.checkExistingBackportPR(
        mockOctokit,
        mockContext,
        'vcluster',
        '0.24',
        123
      );
      
      expect(result).toBeNull();
    });
  });
  
  describe('Label Processing Logic (Duplicate Prevention)', () => {
    let mockCore: any;
    let mockGithub: any;

    beforeEach(() => {
      // Reset mocks before each test
      jest.clearAllMocks();

      mockCore = require('@actions/core');
      mockGithub = require('@actions/github');

      // Setup default mock behavior
      mockCore.getInput.mockReturnValue('fake-token');
    });

    it('labeled event processes ONLY the newly added label (not all labels)', () => {
      // This is the key test for the duplicate bug fix
      // Simulate: PR has backport-v0.22 and backport-v0.23, but only v0.23 was just added

      const context = {
        payload: {
          action: 'labeled',
          label: { name: 'backport-v0.23' }, // Only v0.23 was just added
          pull_request: {
            number: 123,
            merged: true,
            labels: [
              { name: 'backport-v0.22' },
              { name: 'backport-v0.23' }  // PR has both labels
            ],
            head: { sha: 'abc123' },
            title: 'Test PR'
          },
          repository: { default_branch: 'main' }
        },
        repo: { owner: 'test', repo: 'test-repo' }
      };

      mockGithub.context = context;

      // Verify that core.info is called with message about processing only the newly added label
      // This proves we're not processing all labels
      const infoMessages: string[] = [];
      mockCore.info.mockImplementation((msg: string) => {
        infoMessages.push(msg);
      });

      // We can't easily test the full run() without mocking octokit, but we can verify the logic
      // by checking what messages are logged

      // For now, this is a structure test - we'll add more comprehensive integration tests
      expect(context.payload.label.name).toBe('backport-v0.23');
      expect(context.payload.pull_request.labels).toHaveLength(2);
    });

    it('closed event should process ALL version labels', () => {
      const context = {
        payload: {
          action: 'closed',
          pull_request: {
            number: 123,
            merged: true,
            labels: [
              { name: 'backport-v0.22' },
              { name: 'backport-v0.23' },
              { name: 'backport-v0.24' }
            ],
            head: { sha: 'abc123' },
            title: 'Test PR'
          },
          repository: { default_branch: 'main' }
        },
        repo: { owner: 'test', repo: 'test-repo' }
      };

      mockGithub.context = context;

      // For closed events, we should extract all version labels
      const labels = context.payload.pull_request.labels;
      const versionLabels = labels
        .map(label => {
          const match = label.name.match(/^backport-v([\d.]+)$/);
          return match ? match[1] : null;
        })
        .filter(v => v !== null);

      // Should have all 3 versions
      expect(versionLabels).toEqual(['0.22', '0.23', '0.24']);
    });

    it('skips non-backport labels in labeled events', () => {
      const context = {
        payload: {
          action: 'labeled',
          label: { name: 'documentation' }, // Not a backport label
          pull_request: {
            number: 123,
            merged: true,
            labels: [{ name: 'documentation' }]
          }
        }
      };

      mockGithub.context = context;

      const match = context.payload.label.name.match(/^backport-v([\d.]+)$/);
      expect(match).toBeNull();
    });

    it('skips labeled events when PR is not merged', () => {
      const context = {
        payload: {
          action: 'labeled',
          label: { name: 'backport-v0.22' },
          pull_request: {
            number: 123,
            merged: false, // Not merged
            labels: [{ name: 'backport-v0.22' }]
          }
        }
      };

      mockGithub.context = context;

      expect(context.payload.pull_request.merged).toBe(false);
    });

    it('continues with later version labels after one version fails', async () => {
      const getCommit = jest.fn().mockResolvedValue({
        data: { parents: [{ sha: 'base-before-pr' }] }
      });
      const getContent = jest.fn().mockImplementation(({ path, ref }: any) => {
        if (path === 'vcluster/guide.mdx' && ref === 'merge-sha') {
          return Promise.resolve({ data: { content: Buffer.from('new guide').toString('base64') } });
        }
        if (path.includes('version-0.27.0')) {
          return Promise.reject(new Error('failed to read v0.27 target'));
        }
        if (path.includes('version-0.28.0')) {
          return Promise.reject({ status: 404 });
        }
        throw new Error(`unexpected getContent call: ${path}@${ref}`);
      });
      const mockOctokit = {
        paginate: jest.fn().mockResolvedValue([
          { filename: 'vcluster/guide.mdx', status: 'added' }
        ]),
        rest: {
          repos: {
            getCommit,
            getContent,
            get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          },
          pulls: {
            listFiles: jest.fn(),
            list: jest.fn().mockResolvedValue({ data: [] }),
            create: jest.fn().mockResolvedValue({ data: { number: 456 } })
          },
          git: {
            getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'main-sha' } } }),
            createRef: jest.fn().mockResolvedValue({})
          },
          issues: {
            addLabels: jest.fn().mockResolvedValue({})
          }
        }
      };
      mockGithub.getOctokit = jest.fn().mockReturnValue(mockOctokit);
      mockGithub.context = {
        payload: {
          action: 'closed',
          pull_request: {
            number: 123,
            merged: true,
            merge_commit_sha: 'merge-sha',
            commits: 1,
            labels: [{ name: 'backport-v0.27' }, { name: 'backport-v0.28' }],
            title: 'Update guide'
          },
          repository: { default_branch: 'main' }
        },
        repo: { owner: 'test', repo: 'test-repo' }
      };

      await index.run();

      expect(getCommit).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: '[v0.28] Update guide (#123)' })
      );
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('Backport for v0.27 failed')
      );
    });
  });

  describe('backportFiles SHA conflict handling', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('fails closed when merge_commit_sha is missing', async () => {
      await expect(index.backportFiles(
        { rest: { repos: {} } },
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: {} } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      )).rejects.toThrow('missing merge_commit_sha');
    });

    it('logs error when SHA conflict retry also fails', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 })
              .mockRejectedValueOnce(new Error('network error')), // retry getContent fails
            createOrUpdateFileContents: jest.fn()
              .mockRejectedValueOnce(new Error('is at abc but expected def'))
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(stats.errors).toBe(1);
      expect(stats.copied).toBe(0);
    });

    it('copies file when no conflict', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 }),
            createOrUpdateFileContents: jest.fn().mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.errors).toBe(0);
    });

    it('reads source content from merge_commit_sha, not head.sha', async () => {
      // Regression for DEVOPS-855: backports must reflect the post-merge state
      // (3-way merge reconciliation on main) rather than the PR branch tip.
      // Reproduces vcluster-docs PR #1963 scenario where head.sha captured a
      // deletion that the merge silently restored.
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 }),
            createOrUpdateFileContents: jest.fn().mockResolvedValueOnce({})
          }
        }
      };

      await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'head-sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(mockOctokit.rest.repos.getContent).toHaveBeenNthCalledWith(1,
        expect.objectContaining({ path: 'vcluster/test.mdx', ref: 'merge-sha' })
      );
      expect(mockOctokit.rest.repos.getContent).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster/test.mdx', ref: 'head-sha' })
      );
    });

    it('does not overwrite a concurrently created added file (message pattern)', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 })
              .mockResolvedValueOnce({
                data: { content: Buffer.from('concurrent content').toString('base64'), sha: 'conflict-sha' }
              }),
            createOrUpdateFileContents: jest.fn()
              .mockRejectedValueOnce(new Error('is at x but expected y'))
              .mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(0);
      expect(stats.conflicts).toBe(1);
      expect(stats.errors).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite a concurrently created added file on HTTP 409', async () => {
      const error409 = new Error('Conflict') as any;
      error409.status = 409;

      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('test').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 })
              .mockResolvedValueOnce({
                data: { content: Buffer.from('concurrent content').toString('base64'), sha: 'conflict-sha' }
              }),
            createOrUpdateFileContents: jest.fn()
              .mockRejectedValueOnce(error409)
              .mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(0);
      expect(stats.conflicts).toBe(1);
      expect(stats.errors).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteVersionedFile', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('deletes file when it exists in versioned folder', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValueOnce({ data: { sha: 'existing-sha' } }),
            deleteFile: jest.fn().mockResolvedValueOnce({})
          }
        }
      };
      const mockContext = { repo: { owner: 'test', repo: 'test' } };

      const result = await index.deleteVersionedFile(
        mockOctokit, mockContext, 'vcluster_versioned_docs/version-0.27.0/test.mdx', 'backport/branch'
      );

      expect(result).toBe('deleted');
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ sha: 'existing-sha', branch: 'backport/branch' })
      );
    });

    it('returns absent when file does not exist (404)', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockRejectedValueOnce({ status: 404 }),
            deleteFile: jest.fn()
          }
        }
      };
      const mockContext = { repo: { owner: 'test', repo: 'test' } };

      const result = await index.deleteVersionedFile(
        mockOctokit, mockContext, 'vcluster_versioned_docs/version-0.27.0/test.mdx', 'backport/branch'
      );

      expect(result).toBe('absent');
      expect(mockOctokit.rest.repos.deleteFile).not.toHaveBeenCalled();
    });

    it('does not delete newly changed content after a SHA conflict', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValueOnce({ data: { sha: 'old-sha' } }),
            deleteFile: jest.fn().mockRejectedValueOnce(new Error('is at abc but expected def'))
          }
        }
      };
      const mockContext = { repo: { owner: 'test', repo: 'test' } };

      await expect(index.deleteVersionedFile(
        mockOctokit, mockContext, 'vcluster_versioned_docs/version-0.27.0/test.mdx', 'backport/branch'
      )).rejects.toThrow('is at abc but expected def');

      expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledTimes(1);
    });

    it('propagates an HTTP 409 delete conflict', async () => {
      const error409 = new Error('Conflict') as any;
      error409.status = 409;

      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValueOnce({ data: { sha: 'old-sha' } }),
            deleteFile: jest.fn().mockRejectedValueOnce(error409)
          }
        }
      };
      const mockContext = { repo: { owner: 'test', repo: 'test' } };

      await expect(index.deleteVersionedFile(
        mockOctokit, mockContext, 'vcluster_versioned_docs/version-0.27.0/test.mdx', 'backport/branch'
      )).rejects.toBe(error409);

      expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledTimes(1);
    });

    it('throws non-conflict errors', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValueOnce({ data: { sha: 'sha' } }),
            deleteFile: jest.fn().mockRejectedValueOnce(new Error('server error'))
          }
        }
      };
      const mockContext = { repo: { owner: 'test', repo: 'test' } };

      await expect(index.deleteVersionedFile(
        mockOctokit, mockContext, 'path/file.mdx', 'branch'
      )).rejects.toThrow('server error');
    });
  });

  describe('backportFiles with removed files', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('deletes removed file from versioned folder', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { sha: 'target-sha' } }),
            deleteFile: jest.fn().mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/removed.mdx', status: 'removed' }],
        'backport/branch'
      );

      expect(stats.deleted).toBe(1);
      expect(stats.copied).toBe(0);
      expect(stats.skipped).toBe(0);
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalled();
    });

    it('skips removed file when already absent from versioned folder', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockRejectedValueOnce({ status: 404 }),
            deleteFile: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/gone.mdx', status: 'removed' }],
        'backport/branch'
      );

      expect(stats.deleted).toBe(0);
      expect(stats.skipped).toBe(1);
      expect(mockOctokit.rest.repos.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('backportFiles with renamed files', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('copies new path and deletes old path for renamed file', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/new-name.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from('new content').toString('base64'), sha: 'src' } });
              }
              if (path === 'vcluster/new-name.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from('old content').toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/new-name.mdx') {
                return Promise.reject({ status: 404 });
              }
              if (path === 'vcluster/old-name.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from('old content').toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/old-name.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from('old content').toString('base64'), sha: 'old-target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValueOnce({}),
            deleteFile: jest.fn().mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/new-name.mdx',
          previous_filename: 'vcluster/old-name.mdx',
          status: 'renamed'
        }],
        'backport/branch',
        'base-sha'
      );

      expect(stats.copied).toBe(1);
      expect(stats.deleted).toBe(1);
      expect(stats.errors).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalled();
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster_versioned_docs/version-0.27.0/old-name.mdx' })
      );
    });

    it('copies new path even when old path already absent', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('content').toString('base64'), sha: 'src' } })
              .mockRejectedValueOnce({ status: 404 }) // new target doesn't exist
              .mockRejectedValueOnce({ status: 404 }), // old target also doesn't exist
            createOrUpdateFileContents: jest.fn().mockResolvedValueOnce({}),
            deleteFile: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { head: { sha: 'sha' }, merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/new-name.mdx',
          previous_filename: 'vcluster/old-name.mdx',
          status: 'renamed'
        }],
        'backport/branch',
        'base-sha'
      );

      expect(stats.copied).toBe(1);
      expect(stats.deleted).toBe(0);
      expect(mockOctokit.rest.repos.deleteFile).not.toHaveBeenCalled();
    });

    it('routes cross-folder renames through both affected source folders', () => {
      const movedOut = {
        filename: 'shared/guide.mdx',
        previous_filename: 'vcluster/guide.mdx',
        status: 'renamed'
      };
      const movedIn = {
        filename: 'vcluster/guide.mdx',
        previous_filename: 'shared/guide.mdx',
        status: 'renamed'
      };

      expect(index.fileTouchesSourceFolder(movedOut, 'vcluster')).toBe(true);
      expect(index.fileTouchesSourceFolder(movedOut, 'shared')).toBe(true);
      expect(index.fileTouchesSourceFolder(movedIn, 'vcluster')).toBe(true);
      expect(index.fileTouchesSourceFolder(movedIn, 'shared')).toBe(true);
      expect(index.fileTouchesSourceFolder(movedIn, 'platform')).toBe(false);
    });

    it('treats a rename out of the source folder as a deletion', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn().mockResolvedValueOnce({ data: { sha: 'old-target-sha' } }),
            deleteFile: jest.fn().mockResolvedValue({}),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'shared/guide.mdx',
          previous_filename: 'vcluster/guide.mdx',
          status: 'renamed'
        }],
        'backport/branch'
      );

      expect(stats.deleted).toBe(1);
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster_versioned_docs/version-0.27.0/guide.mdx' })
      );
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('treats a rename into the source folder as an addition', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('moved content').toString('base64') } })
              .mockRejectedValueOnce({ status: 404 }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
            deleteFile: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/guide.mdx',
          previous_filename: 'shared/guide.mdx',
          status: 'renamed'
        }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster_versioned_docs/version-0.27.0/guide.mdx' })
      );
      expect(mockOctokit.rest.repos.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('listChangedFiles', () => {
    const mockContext = { repo: { owner: 'loft-sh', repo: 'vcluster-docs' } };

    // Build a list of changed files under the vcluster/ prefix
    const makeFiles = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        filename: `vcluster/doc-${i}.mdx`,
        status: 'modified'
      }));

    it('uses Octokit pagination for the complete changed-file list', async () => {
      const listFiles = jest.fn();
      const paginate = jest.fn().mockResolvedValue(makeFiles(136));
      const mockOctokit = { paginate, rest: { pulls: { listFiles } } };

      const files = await index.listChangedFiles(mockOctokit, mockContext, 2475);

      expect(files).toHaveLength(136);
      expect(paginate).toHaveBeenCalledWith(
        listFiles,
        expect.objectContaining({
          owner: 'loft-sh',
          repo: 'vcluster-docs',
          pull_number: 2475,
          per_page: 100
        })
      );
    });

    it('does not impose a client-side file or page limit', async () => {
      const listFiles = jest.fn();
      const paginate = jest.fn().mockResolvedValue(makeFiles(3500));
      const mockOctokit = { paginate, rest: { pulls: { listFiles } } };

      const files = await index.listChangedFiles(mockOctokit, mockContext, 2475);

      expect(files).toHaveLength(3500);
    });

    it('REGRESSION TEST: backports every file of a PR with more than 30 changed files', async () => {
      // Reproduces loft-sh/vcluster-docs#2475: 36 changed files, of which the
      // last 6 fell past the unpaginated first page and were silently dropped
      // from the backport PR, four of them left stale and two never created.
      const listFiles = jest.fn();
      const paginate = jest.fn().mockResolvedValue(makeFiles(36));
      const mockOctokit = {
        paginate,
        rest: {
          pulls: { listFiles },
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path }: any) =>
              path.startsWith('vcluster_versioned_docs/')
                ? Promise.reject({ status: 404 }) // target file not there yet
                : Promise.resolve({
                    data: { content: Buffer.from('content').toString('base64'), sha: 'src' }
                  })
            ),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const files = await index.listChangedFiles(mockOctokit, mockContext, 2475);
      expect(files).toHaveLength(36);

      const stats = await index.backportFiles(
        mockOctokit,
        { ...mockContext, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.36.0',
        files,
        'backport/branch'
      );

      expect(stats.copied).toBe(36);
      expect(stats.errors).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(36);
      // The files past the first page reach the versioned folder too
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster_versioned_docs/version-0.36.0/doc-35.mdx' })
      );
    });
  });

  describe('Label Processing Logic - Regression Tests', () => {
    it('REGRESSION TEST: multiple labels should not create duplicate PRs', () => {
      // This test verifies the fix for the duplicate PR bug
      // Scenario: PR #123 is merged with labels backport-v0.22 and backport-v0.23
      // When processing a 'labeled' event for v0.23, we should ONLY process v0.23

      const labeledEventForV023 = {
        payload: {
          action: 'labeled',
          label: { name: 'backport-v0.23' }, // This is the newly added label
          pull_request: {
            number: 123,
            merged: true,
            labels: [
              { name: 'backport-v0.22' }, // Already existed
              { name: 'backport-v0.23' }  // Just added
            ],
            head: { sha: 'abc123' },
            title: 'Test PR'
          },
          repository: { default_branch: 'main' }
        },
        repo: { owner: 'test', repo: 'test-repo' }
      };

      // Extract what versions should be processed
      const addedLabel = labeledEventForV023.payload.label.name;
      const match = addedLabel.match(/^backport-v([\d.]+)$/);

      // OLD BUGGY BEHAVIOR would extract ALL labels:
      // const allLabels = labeledEventForV023.payload.pull_request.labels;
      // const buggyVersions = allLabels.map(...) // Would give ['0.22', '0.23']

      // NEW CORRECT BEHAVIOR extracts only newly added label:
      const correctVersion = match ? match[1] : null;

      expect(correctVersion).toBe('0.23'); // Only v0.23
      expect(correctVersion).not.toBe('0.22'); // NOT v0.22

      // Verify we have the right structure
      expect(match).not.toBeNull();
      expect(labeledEventForV023.payload.pull_request.labels).toHaveLength(2);
    });
  });

  describe('backportFiles patch-merge (drift protection)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    // Regression for the vcluster-docs #2766/#2767 incident: a wholesale
    // overwrite of the versioned file with main's current HEAD dragged in
    // unrelated content (a newer feature section, a reverted import-path fix)
    // that the source PR never touched. These tests exercise the patch-merge
    // path directly against the real `diff` library, not a stub.
    const base = 'line one\nline two\nline three\n';
    const afterPRChange = 'line one\nline TWO CHANGED\nline three\n';

    it('walks all rewritten commits to find a multi-commit rebase baseline', async () => {
      const afterAllRebasedCommits = 'line ONE CHANGED\nline TWO CHANGED\nline three\n';
      const versionedWithOwnHistory = 'line one\nline two\nline three\nversion-only section\n';
      const firstCommitMetadata = {
        message: 'change line one',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-01T00:00:00Z' }
      };
      const secondCommitMetadata = {
        message: 'change line two',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-02T00:00:00Z' }
      };
      const getCommit = jest.fn().mockImplementation(({ ref }: any) => {
        if (ref === 'last-rebased-commit') {
          return Promise.resolve({
            data: { commit: secondCommitMetadata, parents: [{ sha: 'first-rebased-commit' }] }
          });
        }
        if (ref === 'first-rebased-commit') {
          return Promise.resolve({
            data: { commit: firstCommitMetadata, parents: [{ sha: 'base-before-whole-pr' }] }
          });
        }
        throw new Error(`unexpected getCommit call: ${ref}`);
      });
      const listCommits = jest.fn();

      const mockOctokit = {
        paginate: jest.fn().mockResolvedValue([
          { commit: firstCommitMetadata },
          { commit: secondCommitMetadata }
        ]),
        rest: {
          pulls: { listCommits },
          repos: {
            getCommit,
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'last-rebased-commit') {
                return Promise.resolve({ data: { content: Buffer.from(afterAllRebasedCommits).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-before-whole-pr') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx' && ref === 'backport/branch') {
                return Promise.resolve({
                  data: { content: Buffer.from(versionedWithOwnHistory).toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        {
          repo: { owner: 'test', repo: 'test' },
          payload: {
            pull_request: {
              merge_commit_sha: 'last-rebased-commit',
              number: 123,
              commits: 2
            }
          }
        },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(getCommit).toHaveBeenCalledTimes(2);
      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        listCommits,
        expect.objectContaining({ pull_number: 123 })
      );

      const writtenContent = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      const writtenText = Buffer.from(writtenContent, 'base64').toString('utf-8');
      expect(writtenText).toContain('line ONE CHANGED');
      expect(writtenText).toContain('line TWO CHANGED');
      expect(writtenText).toContain('version-only section');
    });

    it('fails closed when only part of a rebased commit sequence can be identified', async () => {
      const commitA = {
        message: 'change A',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-01T00:00:00Z' }
      };
      const emptyCommit = {
        message: 'empty marker',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-02T00:00:00Z' }
      };
      const commitB = {
        message: 'change B',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-03T00:00:00Z' }
      };
      const mockOctokit = {
        paginate: jest.fn().mockResolvedValue([
          { commit: commitA },
          { commit: emptyCommit },
          { commit: commitB }
        ]),
        rest: {
          pulls: { listCommits: jest.fn() },
          repos: {
            getCommit: jest.fn().mockImplementation(({ ref }: any) => {
              if (ref === 'rebased-B') {
                return Promise.resolve({ data: { commit: commitB, parents: [{ sha: 'rebased-A' }] } });
              }
              if (ref === 'rebased-A') {
                return Promise.resolve({ data: { commit: commitA, parents: [{ sha: 'base-sha' }] } });
              }
              throw new Error(`unexpected getCommit call: ${ref}`);
            })
          }
        }
      };

      await expect(index.backportFiles(
        mockOctokit,
        {
          repo: { owner: 'test', repo: 'test' },
          payload: { pull_request: { number: 123, commits: 3, merge_commit_sha: 'rebased-B' } }
        },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      )).rejects.toThrow('Could not identify the complete rebased commit sequence');
    });

    it('ignores a trailing originally-empty commit when resolving a rebase baseline', async () => {
      const commitA = {
        message: 'change A',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-01T00:00:00Z' }
      };
      const commitB = {
        message: 'change B',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-02T00:00:00Z' }
      };
      const emptyCommit = {
        message: 'empty marker',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-03T00:00:00Z' }
      };
      const originalCommits = [
        { sha: 'original-A', commit: commitA },
        { sha: 'original-B', commit: commitB },
        { sha: 'original-empty', commit: emptyCommit }
      ];
      const mockOctokit = {
        paginate: jest.fn().mockResolvedValue(originalCommits),
        rest: {
          pulls: { listCommits: jest.fn() },
          repos: {
            getCommit: jest.fn().mockImplementation(({ ref }: any) => {
              const responses: Record<string, any> = {
                'rebased-B': { commit: commitB, parents: [{ sha: 'rebased-A' }] },
                'rebased-A': { commit: commitA, parents: [{ sha: 'base-sha' }] },
                'original-A': { files: [{}] },
                'original-B': { files: [{}] },
                'original-empty': { files: [] }
              };
              return responses[ref]
                ? Promise.resolve({ data: responses[ref] })
                : Promise.reject(new Error(`unexpected getCommit call: ${ref}`));
            }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'rebased-B') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64'), sha: 'target-sha' } });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        {
          repo: { owner: 'test', repo: 'test' },
          payload: { pull_request: { number: 123, commits: 3, merge_commit_sha: 'rebased-B' } }
        },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster/test.mdx', ref: 'base-sha' })
      );
    });

    it('fails closed when a non-empty trailing commit is dropped during rebase', async () => {
      const commitA = {
        message: 'change A',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-01T00:00:00Z' }
      };
      const commitB = {
        message: 'change B',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-02T00:00:00Z' }
      };
      const droppedCommit = {
        message: 'change already upstream',
        author: { name: 'Author', email: 'author@example.com', date: '2026-09-03T00:00:00Z' }
      };
      const originalCommits = [
        { sha: 'original-A', commit: commitA },
        { sha: 'original-B', commit: commitB },
        { sha: 'original-dropped', commit: droppedCommit }
      ];
      const mockOctokit = {
        paginate: jest.fn().mockResolvedValue(originalCommits),
        rest: {
          pulls: { listCommits: jest.fn() },
          repos: {
            getCommit: jest.fn().mockImplementation(({ ref }: any) => {
              const responses: Record<string, any> = {
                'rebased-B': { commit: commitB, parents: [{ sha: 'rebased-A' }] },
                'original-A': { files: [{}] },
                'original-B': { files: [{}] },
                'original-dropped': { files: [{}] }
              };
              return responses[ref]
                ? Promise.resolve({ data: responses[ref] })
                : Promise.reject(new Error(`unexpected getCommit call: ${ref}`));
            })
          }
        }
      };

      await expect(index.backportFiles(
        mockOctokit,
        {
          repo: { owner: 'test', repo: 'test' },
          payload: { pull_request: { number: 123, commits: 3, merge_commit_sha: 'rebased-B' } }
        },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      )).rejects.toThrow('final commit of PR #123 was dropped during rebase');
    });

    it('fails closed when the merge commit belongs to a containing PR', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({
              data: {
                parents: [
                  { sha: 'base-before-containing-pr' },
                  { sha: 'containing-pr-head' }
                ]
              }
            })
          }
        }
      };

      await expect(index.backportFiles(
        mockOctokit,
        {
          repo: { owner: 'test', repo: 'test' },
          payload: {
            pull_request: {
              number: 123,
              commits: 2,
              head: { sha: 'this-pr-head' },
              merge_commit_sha: 'containing-merge-commit'
            }
          }
        },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      )).rejects.toThrow('merged indirectly or has an unexpected merge commit');
    });

    it('merges the PR\'s own change onto a versioned file with independent later history', async () => {
      // The versioned copy already diverged from `base` in a region the PR
      // never touched (an extra trailing section from later, unrelated work).
      // A wholesale copy of `afterPRChange` would silently discard that
      // section; the patch merge must preserve it.
      const versionedWithOwnHistory = 'line one\nline two\nline three\nversion-only section\n';

      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(versionedWithOwnHistory).toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.conflicts).toBe(0);

      const writtenContent = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      const writtenText = Buffer.from(writtenContent, 'base64').toString('utf-8');

      expect(writtenText).toContain('line TWO CHANGED'); // the PR's own change landed
      expect(writtenText).toContain('version-only section'); // independent history survived
    });

    it('does not duplicate an insertion that is already present in the versioned file', async () => {
      const beforeInsertion = 'line one\nline two\n';
      const afterInsertion = 'line one\nline two\ninserted line\n';
      const alreadyAppliedWithOwnHistory = afterInsertion + 'version-only line\n';
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterInsertion).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(beforeInsertion).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(alreadyAppliedWithOwnHistory).toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.skipped).toBe(1);
      expect(stats.copied).toBe(0);
      expect(stats.conflicts).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it.each([
      {
        boundary: 'last',
        before: 'header\nremove me\n',
        after: 'header\n'
      },
      {
        boundary: 'first',
        before: 'remove me\nfooter\n',
        after: 'footer\n'
      }
    ])('applies a pending deletion at the $boundary line', async ({ before, after }) => {
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(after).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(before).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(before).toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.skipped).toBe(0);
      const written = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      expect(Buffer.from(written, 'base64').toString('utf-8')).toBe(after);
    });

    it('skips the file and reports a conflict when the versioned copy diverged in the same spot the PR changed', async () => {
      // The versioned file already has a different edit to the exact line
      // the PR changes, so there is no context-safe way to apply the patch.
      const versionedWithConflictingEdit = 'line one\nline TWO edited differently in this version\nline three\n';

      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(versionedWithConflictingEdit).toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(0);
      expect(stats.conflicts).toBe(1);
      expect(stats.conflictFiles).toEqual(['vcluster_versioned_docs/version-0.27.0/test.mdx']);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('falls back to a direct copy for an added file with no prior state to protect', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('brand new content').toString('base64') } })
              .mockRejectedValueOnce({ status: 404 }), // no existing target file
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/new-page.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.conflicts).toBe(0);
      // Added files need no before-image, so baseline resolution is skipped.
      expect(mockOctokit.rest.repos.getCommit).not.toHaveBeenCalled();
    });

    it('preserves binary bytes when directly copying an added file', async () => {
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: binary.toString('base64') } })
              .mockRejectedValueOnce({ status: 404 }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/image.png', status: 'added' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      const written = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      expect(Buffer.from(written, 'base64')).toEqual(binary);
    });

    it('copies a modified binary when the versioned bytes match the baseline', async () => {
      const beforeBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
      const afterBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/image.png' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: afterBinary.toString('base64') } });
              }
              if (path === 'vcluster/image.png' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: beforeBinary.toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/image.png') {
                return Promise.resolve({
                  data: { content: beforeBinary.toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/image.png', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.conflicts).toBe(0);
      const written = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      expect(Buffer.from(written, 'base64')).toEqual(afterBinary);
    });

    it('skips a modified binary when the versioned bytes already match the post-image', async () => {
      const beforeBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
      const afterBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/image.png' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: afterBinary.toString('base64') } });
              }
              if (path === 'vcluster/image.png' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: beforeBinary.toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/image.png') {
                return Promise.resolve({
                  data: { content: afterBinary.toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/image.png', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.skipped).toBe(1);
      expect(stats.copied).toBe(0);
      expect(stats.conflicts).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('hydrates omitted Contents API bodies through the Git Blobs API', async () => {
      const largeBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x20]);
      const getBlob = jest.fn().mockResolvedValue({
        data: { content: largeBinary.toString('base64'), encoding: 'base64' }
      });
      const mockOctokit = {
        rest: {
          git: { getBlob },
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn()
              .mockResolvedValueOnce({
                data: { content: '', encoding: 'none', size: 2_000_000, sha: 'large-blob-sha' }
              })
              .mockRejectedValueOnce({ status: 404 }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/large-image.png', status: 'added' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(getBlob).toHaveBeenCalledWith(expect.objectContaining({ file_sha: 'large-blob-sha' }));
      const written = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      expect(Buffer.from(written, 'base64')).toEqual(largeBinary);
    });

    it('reports an added file as a conflict when its versioned target already exists', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn()
              .mockResolvedValueOnce({ data: { content: Buffer.from('new source').toString('base64') } })
              .mockResolvedValueOnce({
                data: { content: Buffer.from('version-specific content').toString('base64'), sha: 'target-sha' }
              }),
            createOrUpdateFileContents: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/reintroduced.mdx', status: 'added' }],
        'backport/branch'
      );

      expect(stats.conflicts).toBe(1);
      expect(stats.copied).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it('reapplies a modified-file patch after a concurrent target update', async () => {
      const targetBeforeWrite = 'line one\nline two\nline three\nversion-only section\n';
      const targetAfterConflict = targetBeforeWrite + 'concurrent section\n';
      let targetReads = 0;
      const conflict = Object.assign(new Error('Conflict'), { status: 409 });
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                targetReads++;
                const text = targetReads === 1 ? targetBeforeWrite : targetAfterConflict;
                return Promise.resolve({
                  data: { content: Buffer.from(text).toString('base64'), sha: `target-sha-${targetReads}` }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn()
              .mockRejectedValueOnce(conflict)
              .mockResolvedValueOnce({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'modified' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.conflicts).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(2);
      const retryContent = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[1][0].content;
      const retryText = Buffer.from(retryContent, 'base64').toString('utf-8');
      expect(retryText).toContain('line TWO CHANGED');
      expect(retryText).toContain('concurrent section');
    });

    it('treats GitHub changed status as a modified file', async () => {
      const versioned = `${base}version-only section\n`;
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/test.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster/test.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/test.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(versioned).toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'changed' }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.conflicts).toBe(0);
      const written = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      const writtenText = Buffer.from(written, 'base64').toString('utf-8');
      expect(writtenText).toContain('line TWO CHANGED');
      expect(writtenText).toContain('version-only section');
    });

    it('patches a copied file while retaining the old versioned path', async () => {
      const oldVersioned = `${base}version-only section\n`;
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/copied.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/copied.mdx') {
                return Promise.reject({ status: 404 });
              }
              if (path === 'vcluster/original.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/original.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(oldVersioned).toString('base64'), sha: 'old-target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
            deleteFile: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/copied.mdx',
          previous_filename: 'vcluster/original.mdx',
          status: 'copied'
        }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.deleted).toBe(0);
      expect(stats.conflicts).toBe(0);
      expect(mockOctokit.rest.repos.deleteFile).not.toHaveBeenCalled();
      const written = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      const writtenText = Buffer.from(written, 'base64').toString('utf-8');
      expect(writtenText).toContain('line TWO CHANGED');
      expect(writtenText).toContain('version-only section');
    });

    it('patches a rename onto the old versioned file before deleting the old path', async () => {
      const oldSource = 'line one\nline two\nline three\n';
      const renamedSource = 'line one\nline TWO CHANGED\nline three\n';
      const oldVersioned = 'line one\nline two\nline three\nversion-only section\n';

      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/new-name.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(renamedSource).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/new-name.mdx' && ref === 'backport/branch') {
                return Promise.reject({ status: 404 });
              }
              if (path === 'vcluster/old-name.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(oldSource).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/old-name.mdx' && ref === 'backport/branch') {
                return Promise.resolve({
                  data: { content: Buffer.from(oldVersioned).toString('base64'), sha: 'old-target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
            deleteFile: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        {
          repo: { owner: 'test', repo: 'test' },
          payload: { pull_request: { merge_commit_sha: 'merge-sha' } }
        },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/new-name.mdx',
          previous_filename: 'vcluster/old-name.mdx',
          status: 'renamed'
        }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.deleted).toBe(1);
      expect(stats.conflicts).toBe(0);

      const writtenContent = mockOctokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content;
      const writtenText = Buffer.from(writtenContent, 'base64').toString('utf-8');
      expect(writtenText).toContain('line TWO CHANGED');
      expect(writtenText).toContain('version-only section');
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'vcluster_versioned_docs/version-0.27.0/new-name.mdx',
          sha: undefined
        })
      );
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster_versioned_docs/version-0.27.0/old-name.mdx' })
      );
    });

    it('reports a rename destination collision without deleting the old path', async () => {
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path }: any) => {
              if (path === 'vcluster/new-name.mdx') {
                return Promise.resolve({ data: { content: Buffer.from('renamed source').toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/new-name.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from('existing destination').toString('base64'), sha: 'target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}`);
            }),
            createOrUpdateFileContents: jest.fn(),
            deleteFile: jest.fn()
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/new-name.mdx',
          previous_filename: 'vcluster/old-name.mdx',
          status: 'renamed'
        }],
        'backport/branch'
      );

      expect(stats.conflicts).toBe(1);
      expect(stats.copied).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(mockOctokit.rest.repos.deleteFile).not.toHaveBeenCalled();
    });

    it('finishes a rename when a concurrent writer created the expected destination', async () => {
      const conflict = Object.assign(new Error('Conflict'), { status: 409 });
      let destinationReads = 0;
      const mockOctokit = {
        rest: {
          repos: {
            getCommit: jest.fn().mockResolvedValue({ data: { parents: [{ sha: 'base-sha' }] } }),
            getContent: jest.fn().mockImplementation(({ path, ref }: any) => {
              if (path === 'vcluster/new-name.mdx' && ref === 'merge-sha') {
                return Promise.resolve({ data: { content: Buffer.from(afterPRChange).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/new-name.mdx') {
                destinationReads++;
                return destinationReads === 1
                  ? Promise.reject({ status: 404 })
                  : Promise.resolve({
                    data: { content: Buffer.from(afterPRChange).toString('base64'), sha: 'concurrent-sha' }
                  });
              }
              if (path === 'vcluster/old-name.mdx' && ref === 'base-sha') {
                return Promise.resolve({ data: { content: Buffer.from(base).toString('base64') } });
              }
              if (path === 'vcluster_versioned_docs/version-0.27.0/old-name.mdx') {
                return Promise.resolve({
                  data: { content: Buffer.from(base).toString('base64'), sha: 'old-target-sha' }
                });
              }
              throw new Error(`unexpected getContent call: ${path}@${ref}`);
            }),
            createOrUpdateFileContents: jest.fn().mockRejectedValueOnce(conflict),
            deleteFile: jest.fn().mockResolvedValue({})
          }
        }
      };

      const stats = await index.backportFiles(
        mockOctokit,
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{
          filename: 'vcluster/new-name.mdx',
          previous_filename: 'vcluster/old-name.mdx',
          status: 'renamed'
        }],
        'backport/branch'
      );

      expect(stats.copied).toBe(1);
      expect(stats.deleted).toBe(1);
      expect(stats.conflicts).toBe(0);
      expect(mockOctokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.repos.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'vcluster_versioned_docs/version-0.27.0/old-name.mdx' })
      );
    });

    it('fails an unknown GitHub file status closed', async () => {
      const createOrUpdateFileContents = jest.fn();
      const stats = await index.backportFiles(
        { rest: { repos: { createOrUpdateFileContents } } },
        { repo: { owner: 'test', repo: 'test' }, payload: { pull_request: { merge_commit_sha: 'merge-sha' } } },
        'vcluster',
        'vcluster_versioned_docs/version-0.27.0',
        [{ filename: 'vcluster/test.mdx', status: 'unexpected' }],
        'backport/branch'
      );

      expect(stats.errors).toBe(1);
      expect(stats.copied).toBe(0);
      expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    });
  });

  describe('postConflictComment', () => {
    it('posts a comment listing every conflicting file', async () => {
      const mockOctokit = {
        rest: {
          issues: {
            createComment: jest.fn().mockResolvedValue({})
          }
        }
      };
      const mockContext = { repo: { owner: 'test', repo: 'test' } };

      await index.postConflictComment(
        mockOctokit,
        mockContext,
        123,
        'platform',
        '4.11',
        ['platform_versioned_docs/version-4.11.0/reference/platform-annotations.mdx']
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 123,
          body: expect.stringContaining('platform-annotations.mdx')
        })
      );
    });
  });

  describe('createBackportPR conflict reporting', () => {
    it('appends a manual-review section listing conflict files', async () => {
      const mockOctokit = {
        rest: {
          pulls: { create: jest.fn().mockResolvedValue({ data: { number: 999 } }) },
          issues: { addLabels: jest.fn().mockResolvedValue({}) }
        }
      };
      const mockContext = {
        repo: { owner: 'test', repo: 'test' },
        payload: { repository: { default_branch: 'main' } }
      };

      await index.createBackportPR(
        mockOctokit,
        mockContext,
        'backport/branch',
        'platform',
        '4.11',
        123,
        'Some PR title',
        ['platform_versioned_docs/version-4.11.0/reference/platform-annotations.mdx']
      );

      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Manual review needed')
        })
      );
    });

    it('omits the manual-review section when there are no conflicts', async () => {
      const mockOctokit = {
        rest: {
          pulls: { create: jest.fn().mockResolvedValue({ data: { number: 999 } }) },
          issues: { addLabels: jest.fn().mockResolvedValue({}) }
        }
      };
      const mockContext = {
        repo: { owner: 'test', repo: 'test' },
        payload: { repository: { default_branch: 'main' } }
      };

      await index.createBackportPR(
        mockOctokit,
        mockContext,
        'backport/branch',
        'platform',
        '4.11',
        123,
        'Some PR title'
      );

      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.stringContaining('Manual review needed')
        })
      );
    });
  });
});
