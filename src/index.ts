import * as core from '@actions/core';
import * as github from '@actions/github';
import { createPatch, applyPatch, diffLines } from 'diff';

// Define main folders and their versioned counterparts
const FOLDER_MAPPING: Record<string, string> = {
  'platform': 'platform_versioned_docs',
  'vcluster': 'vcluster_versioned_docs'
};

// Regular expression to match version labels (e.g., backport-v0.22, backport-v4.2)
const VERSION_LABEL_REGEX = /^backport-v([\d.]+)$/;

// GitHub's pulls.listFiles endpoint returns 30 files per page by default and
// serves at most 100 per page.
const FILES_PER_PAGE = 100;

const SUPPORTED_FILE_STATUSES = new Set([
  'added', 'removed', 'modified', 'renamed', 'changed', 'copied', 'unchanged'
]);

export function fileTouchesSourceFolder(file: any, sourceFolder: string): boolean {
  return file.filename.startsWith(`${sourceFolder}/`) ||
    (file.status === 'renamed' && file.previous_filename?.startsWith(`${sourceFolder}/`));
}

// Type for a GitHub label
interface GitHubLabel {
  name: string;
  color?: string;
  description?: string;
}

// Main function, exported for testing
export async function run(): Promise<void> {
  try {
    // Get inputs
    const token = core.getInput('github_token', { required: true });
    
    const octokit = github.getOctokit(token);
    const context = github.context;
    
    // Check if this is a PR event
    if (!context.payload.pull_request) {
      core.setFailed('This action can only be run on pull request events');
      return;
    }
    
    // Get PR details
    const prNumber = context.payload.pull_request.number;
    const merged = context.payload.pull_request.merged || false;
    const labels = context.payload.pull_request.labels || [];
    
    // For label events, only proceed if the added label is a backport label
    let versionLabels: string[] = [];

    if (context.payload.action === 'labeled') {
      const addedLabel = context.payload.label?.name || '';
      const match = addedLabel.match(VERSION_LABEL_REGEX);

      if (!match) {
        core.info(`Added label "${addedLabel}" is not a backport label, skipping`);
        return;
      }

      // Only process label events if the PR is already merged
      if (!merged) {
        core.info('PR is labeled but not merged yet, skipping backport until merge');
        return;
      }

      // For labeled events, only process the newly added label to avoid duplicates
      versionLabels = [match[1]];
      core.info(`Processing only the newly added label: backport-v${match[1]}`);
    } else {
      // If not merged and not a label event, skip
      if (!merged) {
        core.info('PR not merged and not a label event, skipping');
        return;
      }

      // Extract all version labels for closed/merged events
      versionLabels = labels
        .map((label: GitHubLabel) => {
          const match = label.name.match(VERSION_LABEL_REGEX);
          return match ? match[1] : null;
        })
        .filter((v: string | null) => v !== null) as string[];
    }
    
    if (versionLabels.length === 0) {
      core.info('No version labels found, skipping backport');
      return;
    }
    
    // Get changed files from the PR
    const files = await listChangedFiles(octokit, context, prNumber);
    core.info(`PR #${prNumber} has ${files.length} changed files`);

    // Group files by main folder
    const filesByFolder: Record<string, typeof files> = {};
    for (const mainFolder of Object.keys(FOLDER_MAPPING)) {
      filesByFolder[mainFolder] = files.filter(file => fileTouchesSourceFolder(file, mainFolder));
    }

    const mergeCommitSha = context.payload.pull_request.merge_commit_sha;
    if (!mergeCommitSha) {
      throw new Error(`Merged PR #${prNumber} has no merge_commit_sha; refusing an unsafe wholesale copy`);
    }
    // This baseline is PR-wide. Resolve it lazily so an already-existing or
    // irrelevant backport does not perform commit-history work, then reuse
    // the same promise for every requested version.
    let preMergeBaseShaPromise: Promise<string> | null = null;
    const versionErrors: string[] = [];
    
    // Process each version label
    for (const version of versionLabels) {
      try {
      // Determine which main folder this version applies to
      // For vcluster: typically 0.x versions
      // For platform: typically 4.x versions
      let targetMainFolder: string;
      
      if (version.startsWith('0.') || version.startsWith('1.')) {
        targetMainFolder = 'vcluster';
      } else {
        targetMainFolder = 'platform';
      }
      
      const changedFiles = filesByFolder[targetMainFolder];
      
      if (!changedFiles || changedFiles.length === 0) {
        core.info(`No files changed in ${targetMainFolder} for version ${version}, skipping`);
        continue;
      }
      
      // Check if a backport PR already exists for this PR and version
      const existingPR = await checkExistingBackportPR(
        octokit, 
        context, 
        targetMainFolder, 
        version, 
        prNumber
      );
      
      if (existingPR) {
        core.info(`Backport PR #${existingPR.number} already exists for ${targetMainFolder} to v${version}, skipping`);
        continue;
      }
      
      // Construct the versioned folder path based on our folder structure
      // For vcluster, ensure we add .0 suffix if it's missing and version doesn't already have minor part
      // For vcluster versions, always add .0 suffix
      let formattedVersion = version;
      if (targetMainFolder === 'vcluster') {
        formattedVersion = `${version}.0`;
      }
      const versionedFolder = `${FOLDER_MAPPING[targetMainFolder]}/version-${formattedVersion}`;

      if (!preMergeBaseShaPromise) {
        preMergeBaseShaPromise = getPreMergeBaseSha(octokit, context, mergeCommitSha);
      }
      const preMergeBaseSha = await preMergeBaseShaPromise;
      
      // Create a branch for this backport
      const timestamp = new Date().getTime();
      const branchName = `backport/${targetMainFolder}-to-${version}-${timestamp}`;
      
      // Create the branch
      await createBranchForBackport(octokit, context, branchName);
      
      // Process files and get stats
      const stats = await backportFiles(
        octokit, 
        context, 
        targetMainFolder, 
        versionedFolder, 
        changedFiles, 
        branchName,
        preMergeBaseSha
      );

      // Never open a normal-looking PR when one or more files failed to
      // process. The per-file warnings remain in the job log, while failing
      // the action makes the incomplete backport impossible to overlook.
      if (stats.errors > 0) {
        throw new Error(
          `Backport to ${targetMainFolder} v${version} failed for ${stats.errors} file(s); ` +
          `no pull request was created`
        );
      }
      
      // Only create a PR if we successfully copied or deleted at least one file
      if (stats.copied > 0 || stats.deleted > 0) {
        // Get original PR title
        const originalPRTitle = context.payload.pull_request.title;

        // Create a PR
        await createBackportPR(
          octokit,
          context,
          branchName,
          targetMainFolder,
          version,
          prNumber,
          originalPRTitle,
          stats.conflictFiles
        );
      } else {
        core.info(`No files were successfully copied for ${targetMainFolder} to version ${version}, skipping PR creation`);
      }

      // Conflicts need a human regardless of whether a backport PR got
      // created (an all-conflicts backport has nothing to open a PR with,
      // since nothing was actually committed to the branch).
      if (stats.conflictFiles.length > 0) {
        await postConflictComment(octokit, context, prNumber, targetMainFolder, version, stats.conflictFiles);
      }
      } catch (error: any) {
        const message = `Backport for v${version} failed: ${error.message}`;
        core.warning(message);
        versionErrors.push(message);
      }
    }

    if (versionErrors.length > 0) {
      throw new Error(
        `${versionErrors.length} backport version(s) failed after all labels were processed: ` +
        versionErrors.join('; ')
      );
    }
    
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

// Fetch every changed file in the PR, following pagination.
// An unpaginated listFiles call returns only the first 30 files, and the files
// past that boundary vanish before the backport loop starts: they are never
// copied, never logged as skipped, and never counted as errors, so the backport
// PR looks complete while quietly carrying stale or missing pages.
// Exported for testing
export async function listChangedFiles(
  octokit: any,
  context: any,
  prNumber: number
): Promise<any[]> {
  return octokit.paginate(
    octokit.rest.pulls.listFiles,
    {
      ...context.repo,
      pull_number: prNumber,
      per_page: FILES_PER_PAGE
    }
  );
}

async function createBranchForBackport(
  octokit: any,
  context: any,
  branchName: string
): Promise<void> {
  // Get the default branch
  const { data: repo } = await octokit.rest.repos.get({
    ...context.repo
  });
  
  const defaultBranch = repo.default_branch;
  
  // Get the ref for the default branch
  const { data: ref } = await octokit.rest.git.getRef({
    ...context.repo,
    ref: `heads/${defaultBranch}`
  });
  
  // Create the new branch
  await octokit.rest.git.createRef({
    ...context.repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha
  });
  
  core.info(`Created branch ${branchName}`);
}

// Interface for backport statistics
interface BackportStats {
  copied: number;
  deleted: number;
  skipped: number;
  errors: number;
  conflicts: number;
  conflictFiles: string[];
}

// Decode a Contents API response body to UTF-8 text, regardless of whether
// Octokit handed back a base64 string or an already-decoded buffer/array.
function contentBuffer(content: any): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'base64') : Buffer.from(content);
}

function contentBase64(content: any): string {
  return contentBuffer(content).toString('base64');
}

function decodeTextContent(content: any): string | null {
  const bytes = contentBuffer(content);
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeContent(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

type TextPatchResult =
  | { status: 'applied'; text: string; patch: string }
  | { status: 'already-applied'; text: string; patch: string }
  | { status: 'conflict'; patch: string };

// applyPatch is not idempotent for insertion-only hunks. Check whether the
// inverse change can be removed and reapplied to reproduce the target exactly
// before applying the forward patch, so a manually backported insertion is
// not duplicated.
function applyTextChange(currentText: string, beforeText: string, afterText: string, filename: string): TextPatchResult {
  const patch = createPatch(filename, beforeText, afterText);

  // Exact states are unambiguous. In particular, checking the pre-image first
  // prevents boundary deletions from being mistaken for already-applied: an
  // inverse insertion followed by the deletion can otherwise round-trip the
  // unchanged pre-image back to itself.
  if (currentText === beforeText) {
    const applied = applyPatch(currentText, patch);
    return applied === false
      ? { status: 'conflict', patch }
      : { status: 'applied', text: applied, patch };
  }
  if (currentText === afterText) {
    return { status: 'already-applied', text: currentText, patch };
  }

  // The inverse round-trip is only a reliable idempotence signal for a pure
  // insertion. For patches containing deletions, inverse insertion can also
  // round-trip a pending deletion, so let the forward patch decide instead.
  const hasDeletions = diffLines(beforeText, afterText).some(change => change.removed);
  if (!hasDeletions) {
    const reversePatch = createPatch(filename, afterText, beforeText);
    const reverted = applyPatch(currentText, reversePatch);
    if (reverted !== false && applyPatch(reverted, patch) === currentText) {
      return { status: 'already-applied', text: currentText, patch };
    }
  }

  const merged = applyPatch(currentText, patch);
  return merged === false
    ? { status: 'conflict', patch }
    : { status: 'applied', text: merged, patch };
}

// Delete a file from the versioned folder. Returns 'deleted' or 'absent'.
export async function deleteVersionedFile(
  octokit: any,
  context: any,
  targetPath: string,
  branchName: string
): Promise<'deleted' | 'absent'> {
  // Get the file's current SHA
  let sha: string;
  try {
    const { data: existingFile } = await octokit.rest.repos.getContent({
      ...context.repo,
      path: targetPath,
      ref: branchName
    });
    sha = existingFile.sha;
  } catch (error: any) {
    if (error.status === 404) {
      core.info(`File already absent in versioned folder: ${targetPath}`);
      return 'absent';
    }
    throw error;
  }

  // Do not retry a SHA conflict with a newly fetched SHA: the file changed
  // after it was read, so deleting that new content could discard an
  // independent version-specific edit. Propagate the failure instead.
  await octokit.rest.repos.deleteFile({
    ...context.repo,
    path: targetPath,
    message: `Backport: Delete ${targetPath} (removed in source)`,
    sha,
    branch: branchName
  });

  core.info(`Deleted ${targetPath}`);
  return 'deleted';
}

function commitsMatch(original: any, merged: any): boolean {
  return original.commit.message === merged.commit.message &&
    original.commit.author?.name === merged.commit.author?.name &&
    original.commit.author?.email === merged.commit.author?.email &&
    original.commit.author?.date === merged.commit.author?.date;
}

// Resolve the base-branch tip immediately before the PR landed. Merge commits
// and squash commits both use their first parent. A multi-commit rebase has no
// merge commit, so identify its rewritten commits by stable author/message
// metadata and walk across the complete sequence to its preceding parent.
async function getPreMergeBaseSha(
  octokit: any,
  context: any,
  mergeCommitSha: string
): Promise<string> {
  const { data: mergeTip } = await octokit.rest.repos.getCommit({
    ...context.repo,
    ref: mergeCommitSha
  });

  if (!mergeTip.parents?.[0]) {
    throw new Error(`Merged commit ${mergeCommitSha} has no parent`);
  }

  const prCommitCount = context.payload.pull_request.commits || 1;
  if (mergeTip.parents.length > 1) {
    const expectedHeadSha = context.payload.pull_request.head?.sha;
    if (!expectedHeadSha || mergeTip.parents[1]?.sha !== expectedHeadSha) {
      throw new Error(
        `PR #${context.payload.pull_request.number} was merged indirectly or has an unexpected merge commit; ` +
        `automatic backporting is unsafe`
      );
    }
    return mergeTip.parents[0].sha;
  }
  if (prCommitCount <= 1) {
    return mergeTip.parents[0].sha;
  }

  const originalCommits = await octokit.paginate(
    octokit.rest.pulls.listCommits,
    {
      ...context.repo,
      pull_number: context.payload.pull_request.number,
      per_page: FILES_PER_PAGE
    }
  );
  if (originalCommits.length !== prCommitCount) {
    throw new Error(
      `Expected ${prCommitCount} commits for PR #${context.payload.pull_request.number}, ` +
      `but GitHub returned ${originalCommits.length}`
    );
  }

  // GitHub drops commits that were empty before a rebase-and-merge. Remove
  // those from the expected landed sequence before matching from the tip.
  const nonEmptyOriginalCommits = [];
  for (const originalCommit of originalCommits) {
    if (!originalCommit.sha) {
      nonEmptyOriginalCommits.push(originalCommit);
      continue;
    }
    const { data: commitDetails } = await octokit.rest.repos.getCommit({
      ...context.repo,
      ref: originalCommit.sha
    });
    if (!Array.isArray(commitDetails.files) || commitDetails.files.length > 0) {
      nonEmptyOriginalCommits.push(originalCommit);
    }
  }
  if (nonEmptyOriginalCommits.length === 0) {
    throw new Error(`PR #${context.payload.pull_request.number} contains no landed non-empty commits`);
  }

  const immediateParentSha = mergeTip.parents[0].sha;
  let current = mergeTip;
  for (let index = nonEmptyOriginalCommits.length - 1; index >= 0; index--) {
    if (!commitsMatch(nonEmptyOriginalCommits[index], current)) {
      if (index === nonEmptyOriginalCommits.length - 1) {
        const matchesEarlierCommit = nonEmptyOriginalCommits
          .slice(0, -1)
          .some(originalCommit => commitsMatch(originalCommit, current));
        if (matchesEarlierCommit) {
          throw new Error(
            `The final commit of PR #${context.payload.pull_request.number} was dropped during rebase; ` +
            `automatic baseline selection is unsafe`
          );
        }
        // The tip does not match the PR's final commit, so this is a squash
        // commit and its first parent is the pre-merge base.
        return immediateParentSha;
      }
      // Once a rewritten tip commit matched, this is a rebase whose earlier
      // sequence cannot be identified safely (for example, GitHub drops
      // originally empty commits). Never fall back to a partial-PR baseline.
      throw new Error(
        `Could not identify the complete rebased commit sequence for PR ` +
        `#${context.payload.pull_request.number}`
      );
    }
    const parentSha = current.parents?.[0]?.sha;
    if (!parentSha) {
      throw new Error(`Could not walk the rebased commits for PR #${context.payload.pull_request.number}`);
    }
    if (index === 0) {
      return parentSha;
    }
    const { data: parent } = await octokit.rest.repos.getCommit({
      ...context.repo,
      ref: parentSha
    });
    current = parent;
  }

  throw new Error(`Could not resolve the pre-merge base for PR #${context.payload.pull_request.number}`);
}

async function hydrateFileContent(octokit: any, context: any, file: any): Promise<any> {
  const contentUnavailable = file.encoding === 'none' ||
    (typeof file.size === 'number' && file.size > 0 && !file.content);
  if (!contentUnavailable) {
    return file;
  }
  if (!file.sha) {
    throw new Error('GitHub returned file metadata without content or a blob SHA');
  }

  const { data: blob } = await octokit.rest.git.getBlob({
    ...context.repo,
    file_sha: file.sha
  });
  if (!blob.content || blob.encoding !== 'base64') {
    throw new Error(`GitHub did not return complete base64 content for blob ${file.sha}`);
  }
  return { ...file, content: blob.content, encoding: blob.encoding };
}

// Fetch a complete file at a given ref, or null if it did not exist there.
// The Contents API omits bodies for files over 1 MB, so hydrate those through
// the Git Blobs API before any copy, comparison, or patch operation.
async function getFileAtRef(octokit: any, context: any, path: string, ref: string): Promise<any | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      ...context.repo,
      path,
      ref
    });
    if (Array.isArray(data) || data.type === 'dir') {
      throw new Error(`${path} at ${ref} is not a file`);
    }
    return hydrateFileContent(octokit, context, data);
  } catch (error: any) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

// Exported for testing
export async function backportFiles(
  octokit: any,
  context: any,
  sourceFolder: string,
  versionedFolder: string,
  files: any[],
  branchName: string,
  resolvedPreMergeBaseSha?: string
): Promise<BackportStats> {
  // Track stats for reporting
  let copied = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;
  let conflicts = 0;
  const conflictFiles: string[] = [];

  const mergeCommitSha = context.payload.pull_request.merge_commit_sha;
  if (!mergeCommitSha) {
    throw new Error('Merged pull request payload is missing merge_commit_sha; refusing an unsafe wholesale copy');
  }

  // Every file in this PR shares the same pre-merge baseline, so resolve it
  // once instead of per file. run() supplies the PR-wide cached value; direct
  // callers and tests can let this function resolve it lazily.
  const needsPatchBaseline = files.some(file =>
    file.status === 'modified' || file.status === 'changed' ||
    ((file.status === 'renamed' || file.status === 'copied') &&
      file.filename.startsWith(`${sourceFolder}/`) &&
      file.previous_filename?.startsWith(`${sourceFolder}/`)));
  const preMergeBaseSha = resolvedPreMergeBaseSha ||
    (needsPatchBaseline ? await getPreMergeBaseSha(octokit, context, mergeCommitSha) : null);

  for (const file of files) {
    try {
      if (!SUPPORTED_FILE_STATUSES.has(file.status)) {
        throw new Error(`Unsupported GitHub file status "${file.status}" for ${file.filename}`);
      }
      if (file.status === 'unchanged') {
        core.info(`File ${file.filename} is unchanged, skipping`);
        skipped++;
        continue;
      }

      const newPathInSourceFolder = file.filename.startsWith(`${sourceFolder}/`);
      const hasSourcePath = file.status === 'renamed' || file.status === 'copied';
      const oldPathInSourceFolder = hasSourcePath &&
        file.previous_filename?.startsWith(`${sourceFolder}/`);

      // A rename out of this mapped source folder is a removal for this
      // product/version. A rename into it is an addition. Only a rename whose
      // old and new paths are both inside the folder is a content-preserving
      // rename operation.
      if (file.status === 'renamed' && oldPathInSourceFolder && !newPathInSourceFolder) {
        const oldRelativePath = file.previous_filename.substring(sourceFolder.length + 1);
        const oldTargetPath = `${versionedFolder}/${oldRelativePath}`;
        const result = await deleteVersionedFile(octokit, context, oldTargetPath, branchName);
        if (result === 'deleted') {
          deleted++;
        } else {
          skipped++;
        }
        continue;
      }

      let effectiveStatus = file.status;
      if (file.status === 'changed') {
        effectiveStatus = 'modified';
      } else if (hasSourcePath && !oldPathInSourceFolder) {
        effectiveStatus = 'added';
      }

      // Extract the relative path within the source folder
      const relativePath = file.filename.substring(sourceFolder.length + 1);

      // Delete file from versioned folder if it was removed in the PR
      if (effectiveStatus === 'removed') {
        const targetPath = `${versionedFolder}/${relativePath}`;
        const result = await deleteVersionedFile(octokit, context, targetPath, branchName);
        if (result === 'deleted') {
          deleted++;
        } else {
          skipped++;
        }
        continue;
      }

      // Construct the target path in the versioned folder
      // For your structure, we need to copy to version-vX.Y.Z/[original path]
      const targetPath = `${versionedFolder}/${relativePath}`;

      core.info(`Backporting ${file.filename} to ${targetPath}`);

      // Get the file content from the merge commit on the base branch.
      // Using head.sha would capture the pre-merge state and miss changes
      // that the 3-way merge reconciliation applied on main (e.g. deletions
      // silently restored, paths altered). merge_commit_sha is populated for
      // merged PRs across squash, merge-commit, and rebase strategies.
      const sourceFile = await getFileAtRef(octokit, context, file.filename, mergeCommitSha);
      if (!sourceFile) {
        throw new Error(`Merged source file ${file.filename} is missing at ${mergeCommitSha}`);
      }
      const afterBase64 = contentBase64(sourceFile.content);

      // Check if the target file already exists, and fetch its content so we
      // can attempt a patch merge instead of a blind overwrite.
      const existingTargetFile = await getFileAtRef(octokit, context, targetPath, branchName);
      if (!existingTargetFile) {
        core.info(`Target file doesn't exist yet, will create: ${targetPath}`);
      }

      // Reusing an existing destination for an add or rename is ambiguous: it
      // may contain version-specific history unrelated to this PR.
      if ((effectiveStatus === 'added' || effectiveStatus === 'renamed' || effectiveStatus === 'copied') &&
        existingTargetFile) {
        core.warning(`Target path ${targetPath} already exists; leaving it unchanged for manual review.`);
        conflicts++;
        conflictFiles.push(targetPath);
        continue;
      }

      // A rename's version-specific state lives at its old path. Always use
      // that content as the patch target; the new path was checked above for
      // an explicit destination collision.
      let patchTargetFile = effectiveStatus === 'modified' ? existingTargetFile : null;
      if ((effectiveStatus === 'renamed' || effectiveStatus === 'copied') && file.previous_filename) {
        const oldRelativePath = file.previous_filename.substring(sourceFolder.length + 1);
        const oldTargetPath = `${versionedFolder}/${oldRelativePath}`;
        patchTargetFile = await getFileAtRef(octokit, context, oldTargetPath, branchName);
      }

      // Modified and renamed files may have independent version-specific
      // history. Apply only this PR's before/after diff to that current text.
      // Added files, and files this version has never had, have no prior state
      // to protect, so preserve and copy their original bytes directly.
      let finalContent = afterBase64;
      let isMerge = false;
      let patchTexts: { before: string; after: string } | null = null;
      let patchBytes: { before: string; after: string } | null = null;

      const isPatchable = effectiveStatus === 'modified' ||
        effectiveStatus === 'renamed' || effectiveStatus === 'copied';
      if (isPatchable && patchTargetFile && preMergeBaseSha) {
        const beforePath = (effectiveStatus === 'renamed' || effectiveStatus === 'copied') && file.previous_filename
          ? file.previous_filename
          : file.filename;
        const beforeFile = await getFileAtRef(octokit, context, beforePath, preMergeBaseSha);
        if (!beforeFile) {
          core.warning(
            `Could not find the pre-merge content for ${beforePath}. Leaving ${targetPath} unchanged; ` +
            `backport this file's changes manually.`
          );
          conflicts++;
          conflictFiles.push(targetPath);
          continue;
        }

        const beforeBase64 = contentBase64(beforeFile.content);
        const patchTargetBase64 = contentBase64(patchTargetFile.content);
        if (beforeBase64 === afterBase64) {
          if (effectiveStatus === 'renamed' || effectiveStatus === 'copied') {
            // A pure rename still needs a write at the new path, but its
            // version-specific content must remain unchanged.
            finalContent = contentBase64(patchTargetFile.content);
            isMerge = true;
          } else {
            core.info(`No net merged change for ${file.filename}, skipping`);
            skipped++;
            continue;
          }
        } else if (patchTargetBase64 === afterBase64) {
          if (effectiveStatus === 'renamed' || effectiveStatus === 'copied') {
            // The content change is already present at the old path; preserve
            // its bytes while completing the rename.
            finalContent = patchTargetBase64;
            isMerge = true;
          } else {
            core.info(`Changes for ${file.filename} are already present in ${targetPath}, skipping`);
            skipped++;
            continue;
          }
        } else if (patchTargetBase64 === beforeBase64) {
          // With no independent target drift, copying the exact post-image is
          // safe for both text and binary files.
          finalContent = afterBase64;
          patchBytes = { before: beforeBase64, after: afterBase64 };
          isMerge = true;
        } else {
          const beforeText = decodeTextContent(beforeFile.content);
          const afterText = decodeTextContent(sourceFile.content);
          const patchTargetText = decodeTextContent(patchTargetFile.content);
          if (beforeText === null || afterText === null || patchTargetText === null) {
            core.warning(
              `Cannot safely patch binary content for ${file.filename} onto ${targetPath}; ` +
              `leaving it unchanged for manual review.`
            );
            conflicts++;
            conflictFiles.push(targetPath);
            continue;
          }

          const patchResult = applyTextChange(patchTargetText, beforeText, afterText, file.filename);
          patchTexts = { before: beforeText, after: afterText };
          patchBytes = { before: beforeBase64, after: afterBase64 };
          if (patchResult.status === 'conflict') {
            core.warning(
              `Could not cleanly apply the diff for ${file.filename} onto ${targetPath}: ` +
              `its content has diverged from what this PR changed. Leaving it unchanged; ` +
              `backport this file's changes manually.`
            );
            conflicts++;
            conflictFiles.push(targetPath);
            continue;
          }
          if (patchResult.status === 'already-applied' && effectiveStatus === 'modified') {
            core.info(`Changes for ${file.filename} are already present in ${targetPath}, skipping`);
            skipped++;
            continue;
          }
          finalContent = encodeContent(patchResult.text);
          isMerge = true;
        }
      }

      const commitVerb = isMerge ? 'Merge' : 'Copy';
      const commitMessage = `Backport: ${commitVerb} ${file.filename} to ${targetPath}`;

      // Create or update the file in the versioned folder
      try {
        await octokit.rest.repos.createOrUpdateFileContents({
          ...context.repo,
          path: targetPath,
          message: commitMessage,
          content: finalContent,
          branch: branchName,
          sha: existingTargetFile?.sha
        });
      } catch (createError: any) {
        // If the file changed between read and write, never resend stale
        // content. Only a modified text file with a reusable source patch can
        // be recalculated safely; additions and rename collisions need review.
        const isShaConflict = createError.status === 409 || createError.message?.includes('but expected');
        if (isShaConflict) {
          const currentTargetFile = await getFileAtRef(octokit, context, targetPath, branchName);
          if (!currentTargetFile) {
            core.warning(`Target ${targetPath} disappeared concurrently; leaving it for manual review.`);
            conflicts++;
            conflictFiles.push(targetPath);
            continue;
          }
          const currentTargetText = decodeTextContent(currentTargetFile.content);
          const currentTargetBase64 = contentBase64(currentTargetFile.content);
          let destinationAlreadyReady = false;
          if (patchBytes && currentTargetBase64 === patchBytes.after) {
            if (effectiveStatus === 'renamed' || effectiveStatus === 'copied') {
              // The destination appeared concurrently with exactly the bytes
              // we intended to write. Treat it as ready so a rename can still
              // remove its old path (copies simply finish successfully).
              core.info(`Concurrent destination already contains the changes for ${file.filename}`);
              destinationAlreadyReady = true;
            } else {
              core.info(`Concurrent update already contains the changes for ${file.filename}, skipping`);
              skipped++;
              continue;
            }
          }

          if (!destinationAlreadyReady) {
            let retryContent: string | null = null;
            if (patchBytes && currentTargetBase64 === patchBytes.before) {
              retryContent = patchBytes.after;
            }
            if (retryContent === null) {
              const retryResult = effectiveStatus === 'modified' && patchTexts && currentTargetText !== null
                ? applyTextChange(currentTargetText, patchTexts.before, patchTexts.after, file.filename)
                : { status: 'conflict' as const };
              if (retryResult.status === 'conflict') {
                core.warning(`Target ${targetPath} changed concurrently; leaving it unchanged for manual review.`);
                conflicts++;
                conflictFiles.push(targetPath);
                continue;
              }
              if (retryResult.status === 'already-applied') {
                core.info(`Concurrent update already contains the changes for ${file.filename}, skipping`);
                skipped++;
                continue;
              }
              retryContent = encodeContent(retryResult.text);
            }
            await octokit.rest.repos.createOrUpdateFileContents({
              ...context.repo,
              path: targetPath,
              message: commitMessage,
              content: retryContent,
              branch: branchName,
              sha: currentTargetFile.sha
            });
            core.info(`Retry successful for ${targetPath}`);
          }
        } else {
          throw createError;
        }
      }

      copied++;
      core.info(`Backported ${file.filename} to ${targetPath}`);

      // For renamed files, also delete the old path from the versioned folder
      if (effectiveStatus === 'renamed' && file.previous_filename) {
        const oldRelativePath = file.previous_filename.substring(sourceFolder.length + 1);
        const oldTargetPath = `${versionedFolder}/${oldRelativePath}`;
        const result = await deleteVersionedFile(octokit, context, oldTargetPath, branchName);
        if (result === 'deleted') {
          deleted++;
          core.info(`Deleted old path ${oldTargetPath} after rename`);
        } else {
          core.info(`Old path already absent after rename: ${oldTargetPath}`);
        }
      }
    } catch (error: any) {
      errors++;
      core.warning(`Error backporting file ${file.filename}: ${error.message}`);
    }
  }

  // Create stats object
  const stats: BackportStats = {
    copied,
    deleted,
    skipped,
    errors,
    conflicts,
    conflictFiles
  };

  core.info(
    `Backport stats - Copied: ${copied}, Deleted: ${deleted}, Skipped: ${skipped}, ` +
    `Errors: ${errors}, Conflicts: ${conflicts}`
  );

  // Return the stats
  return stats;
}

// Exported for testing
export async function checkExistingBackportPR(
  octokit: any,
  context: any,
  mainFolder: string,
  version: string,
  originalPRNumber: number
): Promise<any | null> {
  try {
    // Search for both open and closed PRs that mention the original PR number
    const states: Array<'open' | 'closed'> = ['open', 'closed'];
    
    for (const state of states) {
      const { data: prs } = await octokit.rest.pulls.list({
        ...context.repo,
        state: state,
        sort: 'created',
        direction: 'desc',
        per_page: 100
      });

      // Look for PRs with the new title format or body referencing original PR
      for (const pr of prs) {
        // Check for new title format: [vX.Y] original title (#PR_NUMBER)
        const matchesNewTitleFormat = pr.title.includes(`[v${version}]`) && pr.title.includes(`(#${originalPRNumber})`);
        // Also check legacy format for backward compatibility
        const matchesLegacyTitle = pr.title.includes(`${mainFolder} changes to v${version}`);
        const referencesOriginalPR = pr.body && pr.body.includes(`Original PR: #${originalPRNumber}`);
        
        if ((matchesNewTitleFormat || (matchesLegacyTitle && referencesOriginalPR))) {
          core.info(`Found existing ${state} backport PR #${pr.number} for ${mainFolder} to v${version} from PR #${originalPRNumber}`);
          return pr;
        }
      }
    }
    
    return null;
  } catch (error: any) {
    core.warning(`Error checking for existing backport PRs: ${error.message}`);
    return null;
  }
}

// Exported for testing
export async function createBackportPR(
  octokit: any,
  context: any,
  branchName: string,
  mainFolder: string,
  version: string,
  originalPRNumber: number,
  originalPRTitle: string,
  conflictFiles: string[] = []
): Promise<void> {
  // Create PR title in the format: [vX.Y] original title (#original_pr_number)
  const prTitle = `[v${version}] ${originalPRTitle} (#${originalPRNumber})`;

  let body = `This PR backports changes from ${mainFolder} to version v${version}.\n\nOriginal PR: #${originalPRNumber}`;
  if (conflictFiles.length > 0) {
    body += `\n\n## Manual review needed\n\nThe following files could not be merged automatically because their ` +
      `content in this version has diverged from what the original PR changed. They were left unchanged here; ` +
      `please backport the relevant changes by hand:\n\n${conflictFiles.map(f => `- \`${f}\``).join('\n')}`;
  }

  // Create a PR
  const { data: pr } = await octokit.rest.pulls.create({
    ...context.repo,
    title: prTitle,
    body,
    head: branchName,
    base: context.payload.repository.default_branch
  });

  // Add labels to the new PR
  await octokit.rest.issues.addLabels({
    ...context.repo,
    issue_number: pr.number,
    labels: ['backport', `version-v${version}`]
  });

  core.info(`Created backport PR #${pr.number} for ${mainFolder} to v${version}`);
}

// Surface merge conflicts on the original PR even when no backport PR could
// be opened (e.g. every changed file conflicted, leaving nothing to commit).
// Exported for testing
export async function postConflictComment(
  octokit: any,
  context: any,
  originalPRNumber: number,
  mainFolder: string,
  version: string,
  conflictFiles: string[]
): Promise<void> {
  const body = `The automated backport of this PR to \`${mainFolder}\` v${version} could not merge the ` +
    `following files, because their content in that version has diverged from what this PR changed. ` +
    `They were left unchanged; please backport the relevant changes by hand:\n\n` +
    conflictFiles.map(f => `- \`${f}\``).join('\n');

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: originalPRNumber,
    body
  });

  core.info(`Posted conflict comment on PR #${originalPRNumber} for ${mainFolder} v${version}`);
}

run();
