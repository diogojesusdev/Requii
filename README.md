# Requii

Requii is a local-first desktop API client built with Electron, React, and Vite. It stores requests and environments on disk so workspaces stay portable, inspectable, and easy to back up.

## Core Features

- File-based workspaces instead of a remote database.
- Request editing for URL, query params, headers, body, and auth.
- Environment variables with nested values and request interpolation.
- OAuth2, bearer, and basic auth support.
- Import and export for Requii workspaces and Insomnia collections.
- Drag-and-drop request and folder organization with persisted order.
- Desktop request execution through Electron IPC.

## Development

- `npm install`: install dependencies.
- `npm run dev`: start the renderer and Electron shell in development mode.
- `npm run build`: compile Electron code and build the production renderer.
- `npm run start`: launch Electron against the production build.

## Generate Binaries

Requii uses `electron-builder` for packaging. Generated artifacts are written to `release/`.

### Windows

- `npm run dist:win`: build the NSIS installer.
- `npm run dist:portable`: build the portable Windows executable.

### macOS

- Run packaging on macOS or on a macOS CI runner.
- `npm run dist:mac`: build DMG and ZIP artifacts.
- `./build-macos.sh`: helper wrapper for native macOS environments.

### Linux

- Run packaging on Linux or on a Linux CI runner.
- `npm run dist:linux`: build AppImage and `tar.gz` artifacts.
- `./build-linux.sh`: helper wrapper for native Linux environments.

### Packaging Notes

- Windows builds can be produced locally on Windows.
- macOS and Linux binaries should be generated on native hosts or CI runners for reliable results.
- Production macOS releases typically require Apple signing and notarization on macOS.
- `dist/`, `dist-electron/`, and `release/` are generated output directories and should never be committed.

## Workspace Storage

On first launch, Requii creates a managed workspace in the app data directory and stores request files plus an `environments.json` file inside that workspace. This keeps the app self-contained while preserving a simple on-disk format for exports and backups.