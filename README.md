# GitLanes

GitKraken-style commit graph viewer. Free and open source (MIT), read-only, works with any local repository — private or public makes no difference.

![GitLanes commit graph](docs/screenshot.png)

## Features

- **GitKraken-style layout**: separate BRANCH/TAG column, curved lane graph with color recycling (adjacent lanes never share a color), author initial avatars
- **WIP & stash rows**: uncommitted changes and every stash appear inline in the graph; stash rows open in the detail panel like any commit
- **Branch sidebar**: collapsible LOCAL / REMOTE / TAGS tree, click to jump to a ref's commit
- **Search**: Cmd+F over message / author / sha across the *entire* history — matches beyond the loaded range are paged in automatically
- **Commit details**: file list with status badges and ±stats (flat or tree view), rename-aware unified diff (virtualized for huge diffs)
- **Repo tabs**: several repositories side by side, each with its own state
- **Path highlight**: selecting a commit dims everything outside its ancestry, so you can read one branch through a busy graph
- **Context menu**: copy sha/message, open the commit on GitHub/your remote
- **Live**: auto-refreshes when the repository changes (refs fingerprint polling, focused window only); update badge when a newer release exists
- **Fast**: Rust backend wrapping the system `git` CLI, parallel subprocess calls, canvas rendering with virtual scrolling — a 32k-commit repository loads in ~300ms and scrolls at 60fps
- **Read-only by design**: no staging, no push, no way to break anything; use it alongside your favorite git client
- Draggable column widths, keyboard navigation (↑/↓), sha copy (button or row double-click), eye-comfort dark theme

## Install

Grab the latest build from [Releases](https://github.com/nobel6018/gitlanes/releases) (macOS arm64/x86_64, Windows, Linux).

macOS builds are unsigned for now: right-click → Open on first launch.

## Usage

```bash
# open a repo from the command line
gitlanes /path/to/repo

# or via environment variable
GITLANES_REPO=/path/to/repo gitlanes
```

Or just launch the app and use Open Repository / recent list.

## Development

```bash
npm install
npm run tauri dev                 # run the app
cargo test --manifest-path src-tauri/Cargo.toml   # backend tests

# headless backend check on any repo (timing, lanes, WIP, stashes)
src-tauri/target/release/gitlanes --dump /path/to/repo

# browser harnesses (no Tauri needed) — with `npm run dev` running:
#   http://localhost:1420/dev-mock.html   GraphView only, mock data
#   http://localhost:1420/dev-app.html    full app with mocked IPC
```

Requires Rust toolchain, Node 22+, and git >= 2.30. Interface contracts between packages live in [CONTRACTS.md](CONTRACTS.md).

## License

MIT
