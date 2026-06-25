# PatchWarden Performance Notes

## Current State (v0.6.1)

### Identified Optimization Opportunities

The following performance optimizations have been identified for future implementation. They are documented here rather than implemented in v0.6.1 to avoid introducing risk to the core task execution path.

### 1. Async Git Operations in changeCapture.ts

**Current**: `runGit()` uses `spawnSync()` which blocks the event loop during git operations.

**Proposed**: Replace with `execFile()` (async) and use `Promise.all()` for independent git queries in `captureRepoSnapshot()`.

**Risk**: Medium — changes the core change capture path. Requires careful testing of all snapshot/diff/scope scenarios.

**Expected Benefit**: ~200-500ms improvement per task for repos with many files, as multiple git queries can run concurrently.

### 2. Streaming File Hash

**Current**: `computeFileSha256()` reads the entire file into memory with `readFileSync()`.

**Proposed**: Use `createReadStream()` + `crypto.createHash()` for streaming hash computation.

**Risk**: Low — isolated to hash computation, no semantic change.

**Expected Benefit**: Reduces peak memory usage for large files (e.g., release artifacts > 5MB).

### 3. Workspace Snapshot Caching

**Current**: `walkWorkspace()` traverses the entire workspace directory tree on every snapshot.

**Proposed**: Cache the directory listing and invalidate on file modification events.

**Risk**: High — requires file system watchers and cache invalidation logic. Could introduce stale data bugs.

**Expected Benefit**: ~100-1000ms improvement for large workspaces with many repos.

### 4. Parallel Task Status Reads

**Current**: `listTasks()` reads each task's `status.json` sequentially.

**Proposed**: Use `Promise.all()` to read multiple task status files concurrently.

**Risk**: Low — read-only operation, no semantic change.

**Expected Benefit**: ~50-200ms improvement when listing 10+ tasks.

## Decision for v0.6.1

All four optimizations are deferred to a future release. The current synchronous implementation is correct and well-tested. Changing the core paths would require extensive regression testing that is beyond the scope of this stability release.

## Monitoring

The structured logging module (`src/logging.ts`) added in v0.6.1 provides the infrastructure to measure tool call durations (`duration_ms` in audit logs). Once deployed, real-world timing data can be collected to prioritize which optimization to implement first.
