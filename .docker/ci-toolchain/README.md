# CI Toolchain Container

This container provides a consistent, pre-configured environment for our CI/CD pipeline.

## Benefits

### 🚀 Faster CI Runs
- **Before**: ~1-2 minutes to install dependencies each run
- **After**: ~10 seconds (container already has everything)
- **Savings**: 50-80% faster job startup

### 🔒 Consistency
- Same Node.js version across all CI runs
- Pre-installed tools (pnpm, turbo, lefthook, vercel)
- No more "works on my machine" issues

### 💰 Cost Savings
- Reduced GitHub Actions minutes usage
- Less bandwidth for dependency downloads
- Cached container layers

## Container Contents

- **Base**: Node.js 22 Alpine Linux
- **Package Manager**: pnpm 10.22.0
- **Build Tools**: turbo (latest)
- **Linting**: lefthook (latest)
- **Deployment**: vercel CLI (latest)
- **Utilities**: git, bash, curl, make, python3, jq

## Usage

The container is automatically used by our GitHub Actions workflows:

```yaml
jobs:
  test:
    container:
      image: ghcr.io/vm0-ai/vm0-toolchain:latest
```

## Building Locally

```bash
# Build the container
docker build -f .docker/ci-toolchain/Dockerfile -t vm0-toolchain .

# Run interactive shell
docker run -it --rm -v $(pwd):/workspace vm0-toolchain

# Run commands
docker run -it --rm -v $(pwd):/workspace vm0-toolchain pnpm test
```

## Updating the Container

1. Modify `.docker/ci-toolchain/Dockerfile`
2. Push to main branch or create a PR
3. GitHub Actions will automatically build and publish the new image
4. Update `CI_CONTAINER_IMAGE` in workflows if needed

## Container Registry

Images are stored in GitHub Container Registry:
- **Latest**: `ghcr.io/vm0-ai/vm0-toolchain:latest`
- **Specific SHA**: `ghcr.io/vm0-ai/vm0-toolchain:main-<sha>`

## Performance Comparison

| Task | Without Container | With Container | Improvement |
|------|------------------|----------------|-------------|
| Setup Node | 15s | 0s | 100% |
| Install pnpm | 20s | 0s | 100% |
| Install global tools | 30s | 0s | 100% |
| pnpm install (cached) | 45s | 30s | 33% |
| **Total Setup** | **110s** | **30s** | **73%** |

## Maintenance

The container is automatically rebuilt when:
- Dockerfile changes
- Manual trigger via GitHub UI
- Weekly schedule (to get security updates)

## Troubleshooting

### Container fails to pull
- Check GitHub packages permissions
- Ensure GITHUB_TOKEN has `packages: read` permission

### Tools not found
- Container might be outdated
- Trigger a manual rebuild via GitHub Actions

### Different behavior locally vs CI
- Ensure using the same container image tag
- Check for environment variable differences