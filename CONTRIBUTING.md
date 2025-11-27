# Contributing to vm0

## Development Setup

This project uses [Dev Containers](https://containers.dev/) for development. The dev container includes all required dependencies and tools.

### Prerequisites

- [Docker](https://www.docker.com/) (or [OrbStack](https://orbstack.dev/) for macOS, recommended)
- [VS Code](https://code.visualstudio.com/) with [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

### Getting Started

1. Fork and clone the repository
2. Open VS Code and run `Dev Containers: Open Workspace in Container` from the command palette
3. Select the `vm0.code-workspace` file in the project root
4. The container will build and set up the development environment automatically
5. Initialize git hooks: `lefthook install`

### Local Web Development

To run the web application locally with HTTPS:

1. **Generate certificates** (on host machine):
   ```bash
   bash scripts/generate-certs.sh
   ```

2. **Configure hosts** (on host machine):
   Add the following entries to your hosts file (`/etc/hosts` on macOS/Linux, `C:\Windows\System32\drivers\etc\hosts` on Windows):
   ```
   127.0.0.1 vm7.ai www.vm7.ai docs.vm7.ai
   ```

3. **Start the dev server** (inside dev container):
   ```bash
   cd turbo && pnpm install && pnpm dev
   ```

4. **Access the application**:
   Open https://vm7.ai:8443/ in your browser.

## Pull Request Process

1. Create a new branch from `main`
2. Make your changes
3. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/) format
4. Push your branch and create a pull request
