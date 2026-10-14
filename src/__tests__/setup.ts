// Setting up global mocks that will be available to all tests
jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  warning: jest.fn()
}));
