# Docs Backport Action

A GitHub Action to backport documentation changes between folders in Docusaurus projects. This action is specifically designed for the loft-sh/vcluster-docs repository structure.

## How It Works

This action automatically backports changes from main documentation folders (vcluster, platform) to versioned documentation folders when PRs are merged or labeled with version-specific labels.

## Usage

Create a workflow file in your repository:

```yaml
name: Backport Documentation

on:
  pull_request:
    types: [closed, labeled]
    paths:
      - 'vcluster/**'
      - 'platform/**'

jobs:
  backport:
    runs-on: ubuntu-latest
    if: github.event.pull_request.merged == true || 
        (github.event.action == 'labeled' && startsWith(github.event.label.name, 'backport-v'))
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      
      - name: Backport Docusaurus Changes
        uses: loft-sh/docs-backport-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
## Inputs

- `github_token`: GitHub token to authenticate API requests (required)

## Labels

Add labels to PRs to specify which version(s) to backport to:

- `backport-v0.22` - Backport to vcluster v0.22
- `backport-v4.2` - Backport to platform v4.2

## Development

### Prerequisites

- Node.js 20.x
- npm

### Setup

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build the action
npm run build
```

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Releasing

1. Changes pushed to the `main` branch are automatically tested.
2. To create a new release, use the "Release" GitHub workflow with the desired version number.
3. After a release is created, the major version tag (e.g., `v1`) is automatically updated.

#### Manually updating the v1 tag

If you need to manually update the v1 tag to point to the current commit:

```bash
# Update the local v1 tag to point to the current commit
git tag -f v1

# Force push the updated tag to the remote repository
# Use --no-verify if you have pre-push hooks that would block the push
git push -f origin v1 --no-verify
```

## License

MIT
