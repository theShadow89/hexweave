# Releasing Hexweave

Step-by-step guide to publish releases on GitHub using [git-flow](https://danielkummer.github.io/git-flow-cheatsheet/). Written for the first release (`v0.1.0`), reusable for future ones.

Replace `OWNER` with your GitHub username or org (e.g. `scastoldi`) wherever it appears below.

---

## First-time setup

Skip this section on subsequent releases: the repo and gitflow config persist.

### 1. Initialize the git repo (if not already)

```bash
cd ~/Projects/hsw-builder
git status || git init
```

### 2. Create the GitHub repo

Create it **empty** (no README, no LICENSE, no .gitignore) so we can push our history without conflicts:

- Web UI: <https://github.com/new>, name `hexweave`, visibility Public, do NOT tick any of "Add a README", "Add .gitignore", "Choose a license".
- Or CLI: `gh repo create OWNER/hexweave --public --description "Printable Honeycomb Storage Wall panel generator"`

### 3. Wire up the remote

```bash
git remote add origin git@github.com:OWNER/hexweave.git
git remote -v   # sanity check
```

If `origin` already points elsewhere, use `git remote set-url origin ...` instead.

### 4. Install git-flow

Pick one:

```bash
# Recommended: git-flow AVH edition (actively maintained fork)
brew install git-flow-avh

# Or the original (still works)
brew install git-flow
```

Verify: `git flow version` should print a version string.

### 5. Initialize git-flow in the repo

```bash
git flow init
```

Accept ALL defaults by pressing Enter at every prompt:

| Prompt | Answer |
|---|---|
| Branch name for production releases | `main` |
| Branch name for "next release" development | `develop` |
| Feature branch prefix | `feature/` |
| Bugfix branches | `bugfix/` |
| Release branches | `release/` |
| Hotfix branches | `hotfix/` |
| Support branches | `support/` |
| Version tag prefix | *(leave empty, we tag `v0.1.0` explicitly)* |
| Hooks and filters directory | *(default)* |

After this you should be on the `develop` branch. Confirm: `git branch --show-current` prints `develop`.

### 6. Initial push (only once, before any release)

```bash
git add .
git commit -m "chore: initial commit"
git checkout main
git merge develop
git push -u origin main
git checkout develop
git push -u origin develop
```

This seeds both long-lived branches on the remote.

---

## Publishing v0.1.0 (first release)

### Step 1: Pre-flight checks

```bash
cd ~/Projects/hsw-builder
git checkout develop
git pull origin develop
git status                     # must be clean
```

Then run the full local gate:

```bash
npm run typecheck && \
npm test && \
ORIGINAL_STL_DIR=~/Downloads/honeycomb-storage-wall-model_files npm test -- original-match && \
npm run build
```

**All three must exit 0.** If anything fails, fix and commit on `develop` before continuing.

### Step 2: Start the release branch

```bash
git flow release start v0.1.0
```

This creates and checks out `release/v0.1.0` off `develop`. From here you make ONLY release-prep commits (version bump, changelog, last-minute copy). No new features.

### Step 3: Bump version and finalize docs

Verify the version already matches:

```bash
grep '"version"' package.json    # should show "0.1.0"
```

If it does not, edit `package.json` and commit:

```bash
git add package.json package-lock.json
git commit -m "chore(release): bump version to 0.1.0"
```

Update `CHANGELOG.md` so the `## [0.1.0]` section is complete and dated. Then:

```bash
git add CHANGELOG.md
git commit -m "docs(release): finalize v0.1.0 changelog"
```

Sweep for any lingering copy issues (README URLs, screenshots, badges pointing at the wrong repo). Commit as needed.

### Step 4: Finish the release

```bash
git flow release finish v0.1.0
```

Git-flow now:

1. Merges `release/v0.1.0` into `main`
2. Tags `main` with `v0.1.0`
3. Merges `release/v0.1.0` back into `develop`
4. Deletes the `release/v0.1.0` branch

You will be prompted (up to three times) for merge commit messages: press `:wq` (vim) or `Ctrl+X`+`Y`+`Enter` (nano) to accept the defaults. And an editor will open for the tag annotation: use `Release v0.1.0` or paste the changelog for that version.

To skip the editor prompts, pre-supply everything:

```bash
git flow release finish v0.1.0 \
  -m "Release v0.1.0" \
  --push --pushtag
```

The `--push --pushtag` flags do Step 5 automatically. If you use them, skip Step 5.

### Step 5: Push branches and tag

Only if you did NOT use `--push --pushtag` above:

```bash
git push origin main
git push origin develop
git push origin --tags        # or: git push origin v0.1.0
```

Verify on GitHub: `main` should show the release commit, and the tag `v0.1.0` should appear under Tags.

### Step 6: Create the GitHub Release from the tag

CLI (preferred):

```bash
gh release create v0.1.0 \
  --title "Hexweave v0.1.0" \
  --notes-file CHANGELOG.md
```

If you want release notes to include ONLY the v0.1.0 section, extract it first:

```bash
awk '/^## \[0.1.0\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md > /tmp/notes.md
gh release create v0.1.0 --title "Hexweave v0.1.0" --notes-file /tmp/notes.md
```

Web UI alternative: <https://github.com/OWNER/hexweave/releases/new>, pick tag `v0.1.0`, paste notes.

---

## Docker image (optional distribution)

Publish the image to GitHub Container Registry so users can `docker run ghcr.io/OWNER/hexweave:v0.1.0`.

### One-time: authenticate to ghcr.io

Create a Personal Access Token (classic) at <https://github.com/settings/tokens> with scope `write:packages` (and `read:packages`, `delete:packages` if you want to prune later). Save it to an env var:

```bash
export CR_PAT=ghp_xxxxxxxxxxxxxxxxxxxx
echo "$CR_PAT" | docker login ghcr.io -u OWNER --password-stdin
```

### Build, tag, push

```bash
docker build \
  -t ghcr.io/OWNER/hexweave:v0.1.0 \
  -t ghcr.io/OWNER/hexweave:latest \
  .

docker push ghcr.io/OWNER/hexweave:v0.1.0
docker push ghcr.io/OWNER/hexweave:latest
```

After the first push, go to the package page on GitHub and set visibility to Public if you want it pullable without auth.

Smoke test:

```bash
docker run --rm -p 3000:3000 ghcr.io/OWNER/hexweave:v0.1.0
# open http://localhost:3000
```

---

## Post-release

Get back to a clean working state on `develop`:

```bash
git checkout develop
git pull origin develop
```

Start the next feature:

```bash
git flow feature start my-next-thing
# ...code, commit...
git flow feature finish my-next-thing
git push origin develop
```

---

## Fixes to a released version (hotfix flow)

Use this when `main` is broken and `develop` has moved on. The hotfix branches off `main`, not `develop`.

```bash
git flow hotfix start v0.1.1
# fix the bug, commit
# bump package.json to 0.1.1, commit
# add CHANGELOG entry, commit
git flow hotfix finish v0.1.1
# accept the editor prompts, or use -m "..."
git push origin main
git push origin develop
git push origin --tags
```

Then create the GitHub Release for `v0.1.1` (same command as Step 6, swap the version).

---

## Gotchas

- **Never force-push `main` once a tag is published.** Downstream users have pinned that SHA. Roll forward with a hotfix instead.
- **`git flow release finish` needs a clean working tree.** Commit or stash pending changes first (`git stash -u` if you have untracked files you want to keep).
- **Redoing a botched tag.** If you pushed `v0.1.0` but need to redo it BEFORE anyone consumed it:
  ```bash
  git tag -d v0.1.0                          # local
  git push origin :refs/tags/v0.1.0          # remote
  gh release delete v0.1.0 --yes             # GitHub Release, if created
  ```
  Then re-run the release flow. If the tag was already consumed (packages, users pinning), do a `v0.1.1` hotfix instead.
- **README and LICENSE URLs.** After creating the GitHub repo, grep for placeholders that referenced the old URL or `OWNER`:
  ```bash
  grep -rnE '(OWNER|your-username|TODO_REPO_URL)' README.md LICENSE package.json
  ```
  Fix and commit on `develop` before starting the release branch.
- **`main` vs `master`.** If `git flow init` was run before with defaults from an older git-flow that used `master`, your production branch is `master`, not `main`. Check `git branch -a` and adjust every command above. To rename: `git branch -m master main && git push -u origin main && git push origin --delete master` (only safe before the first release).
- **Signed commits/tags.** If your git config requires GPG signing, git-flow will invoke it during merges and tag creation. Have your GPG agent unlocked before running `git flow release finish`.
- **CI on tags.** If you have GitHub Actions that trigger on `push: tags: ['v*']`, they will run once `git push --tags` completes. Confirm they pass before creating the GitHub Release, or the release notes may reference a broken build.
- **Docker version consistency.** The image tag (`v0.1.0`) must match the git tag exactly. Do not push `ghcr.io/OWNER/hexweave:v0.1.0` from a dirty tree; build from the tagged commit:
  ```bash
  git checkout v0.1.0
  docker build -t ghcr.io/OWNER/hexweave:v0.1.0 -t ghcr.io/OWNER/hexweave:latest .
  git checkout develop
  ```

---

## Quick reference: the whole flow in 10 lines

Assuming setup is done, `develop` is clean, and checks pass:

```bash
git checkout develop && git pull
npm run typecheck && npm test && npm run build
git flow release start v0.1.0
# (edit package.json + CHANGELOG.md, commit)
git flow release finish v0.1.0 -m "Release v0.1.0" --push --pushtag
gh release create v0.1.0 --title "Hexweave v0.1.0" --notes-file CHANGELOG.md
docker build -t ghcr.io/OWNER/hexweave:v0.1.0 -t ghcr.io/OWNER/hexweave:latest .
docker push ghcr.io/OWNER/hexweave:v0.1.0 && docker push ghcr.io/OWNER/hexweave:latest
```
