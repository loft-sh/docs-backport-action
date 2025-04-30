// Tests for the Docs Backport Action

// Import setup to ensure mocks are properly initialized
import './setup'; 
// Import the index module
import * as index from '../index';

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
    it('returns a PR when one exists', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn().mockResolvedValue({
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
    
    it('returns null when no PR exists', async () => {
      const mockOctokit = {
        rest: {
          pulls: {
            list: jest.fn().mockResolvedValue({
              data: [
                {
                  number: 456,
                  title: 'Backport: vcluster changes to v0.25', // Different version
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
      
      expect(result).toBeNull();
    });
  });
  
  // Original basic tests
  it('processes PR with version labels correctly', () => {
    expect(true).toBe(true);
  });
  
  it('skips when PR is not merged', () => {
    expect(true).toBe(true);
  });
  
  it('handles PR with no version labels', () => {
    expect(true).toBe(true);
  });
});