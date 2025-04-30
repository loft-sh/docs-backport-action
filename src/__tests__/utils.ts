import { Context } from '@actions/github/lib/context';

// Create a properly typed mock GitHub client
export const createMockGitHubClient = () => {
  return {
    rest: {
      pulls: {
        listFiles: jest.fn().mockResolvedValue({
          data: [
            { filename: 'vcluster/guide.md', status: 'modified' },
            { filename: 'platform/intro.md', status: 'modified' },
            { filename: 'other/file.md', status: 'modified' }
          ]
        }),
        create: jest.fn().mockResolvedValue({
          data: { number: 456 }
        })
      },
      repos: {
        get: jest.fn().mockResolvedValue({
          data: { default_branch: 'main' }
        }),
        getContent: jest.fn().mockResolvedValue({
          data: { content: Buffer.from('Test content').toString('base64') }
        }),
        createOrUpdateFileContents: jest.fn().mockResolvedValue({})
      },
      git: {
        getRef: jest.fn().mockResolvedValue({
          data: { object: { sha: 'def456' } }
        }),
        createRef: jest.fn().mockResolvedValue({})
      },
      issues: {
        addLabels: jest.fn().mockResolvedValue({})
      }
    }
  };
};

// Create a mock context that matches the Context type
export const createMockContext = (overrides: any = {}): Partial<Context> => {
  return {
    eventName: 'pull_request',
    sha: 'abc123',
    ref: 'refs/heads/main',
    workflow: 'Test Workflow',
    action: 'Test Action',
    actor: 'test-user',
    job: 'test-job',
    runNumber: 1,
    runId: 123456,
    apiUrl: 'https://api.github.com',
    serverUrl: 'https://github.com',
    graphqlUrl: 'https://api.github.com/graphql',
    repo: {
      owner: 'loft-sh',
      repo: 'vcluster-docs'
    },
    issue: {
      owner: 'loft-sh',
      repo: 'vcluster-docs',
      number: 123
    },
    payload: {
      action: 'closed',
      pull_request: {
        number: 123,
        merged: true,
        labels: [{ name: 'backport-v0.22' }, { name: 'backport-v4.2' }, { name: 'backport-v0.24' }],
        head: { sha: 'abc123' }
      },
      repository: {
        default_branch: 'main'
      }
    },
    ...overrides
  };
};
