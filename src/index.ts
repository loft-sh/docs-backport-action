import * as core from '@actions/core';
import * as github from '@actions/github';
import { createPatch, applyPatch } from 'diff';

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
      filesByFolder[mainFolder] = files.filter(file => 
        file.filename.startsWith(`${mainFolder}/`));
    }
    
    // Process each version label
    for (const version of versionLabels) {
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
        branchName
      );
      
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
function decodeContent(content: any): string {
  if (typeof content === 'string') {
    return Buffer.from(content, 'base64').toString('utf-8');
  }
  return Buffer.from(content).toString('utf-8');
}

function encodeContent(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
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

  // Delete the file, with SHA conflict retry
  try {
    await octokit.rest.repos.deleteFile({
      ...context.repo,
      path: targetPath,
      message: `Backport: Delete ${targetPath} (removed in source)`,
      sha,
      branch: branchName
    });
  } catch (deleteError: any) {
    const isShaConflict = deleteError.status === 409 || deleteError.message?.includes('but expected');
    if (isShaConflict) {
      core.info(`SHA conflict on delete for ${targetPath}, retrying...`);
      const { data: conflictFile } = await octokit.rest.repos.getContent({
        ...context.repo,
        path: targetPath,
        ref: branchName
      });
      await octokit.rest.repos.deleteFile({
        ...context.repo,
        path: targetPath,
        message: `Backport: Delete ${targetPath} (removed in source)`,
        sha: conflictFile.sha,
        branch: branchName
      });
    } else {
      throw deleteError;
    }
  }

  core.info(`Deleted ${targetPath}`);
  return 'deleted';
}

// Fetch the SHA of the commit immediately before this PR's changes landed on
// the base branch. For both merge commits and squash commits, parents[0] is
// the base branch tip at merge time, so the file content at this SHA is the
// PR's own diff baseline: unaffected by whatever else has merged to the
// default branch since (which is exactly the drift that leaks into every
// open backport when we instead copy today's HEAD wholesale).
async function getPreMergeBaseSha(octokit: any, context: any, mergeCommitSha: string): Promise<string> {
  const { data: commit } = await octokit.rest.repos.getCommit({
    ...context.repo,
    ref: mergeCommitSha
  });
  return commit.parents[0].sha;
}

// Fetch a file's text content at a given ref, or null if it didn't exist there.
async function getContentAtRef(octokit: any, context: any, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      ...context.repo,
      path,
      ref
    });
    return decodeContent(data.content);
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
  branchName: string
): Promise<BackportStats> {
  // Track stats for reporting
  let copied = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;
  let conflicts = 0;
  const conflictFiles: string[] = [];

  const mergeCommitSha = context.payload.pull_request.merge_commit_sha;

  // Every file in this PR shares the same pre-merge baseline, so resolve it
  // once instead of per file.
  let preMergeBaseSha: string | null = null;
  if (mergeCommitSha) {
    preMergeBaseSha = await getPreMergeBaseSha(octokit, context, mergeCommitSha);
  }

  for (const file of files) {
    try {
      // Extract the relative path within the source folder
      const relativePath = file.filename.substring(sourceFolder.length + 1);

      // Delete file from versioned folder if it was removed in the PR
      if (file.status === 'removed') {
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
      const { data: content } = await octokit.rest.repos.getContent({
        ...context.repo,
        path: file.filename,
        ref: mergeCommitSha
      });
      const afterText = decodeContent(content.content);

      // Check if the target file already exists, and fetch its content so we
      // can attempt a patch merge instead of a blind overwrite.
      let sha = '';
      let existingTargetText: string | null = null;
      try {
        const { data: existingFile } = await octokit.rest.repos.getContent({
          ...context.repo,
          path: targetPath,
          ref: branchName
        });
        sha = existingFile.sha;
        existingTargetText = decodeContent(existingFile.content);
      } catch (error) {
        // File doesn't exist yet, which is fine
        core.info(`Target file doesn't exist yet, will create: ${targetPath}`);
      }

      // Decide what to write. Only a modified file landing on top of a
      // versioned file that already exists can carry unrelated drift (the
      // versioned copy may have its own independent history since the
      // version branched, e.g. a later fix that a wholesale copy of main's
      // current HEAD would silently revert). In that case, apply just this
      // PR's own diff via a patch merge instead of overwriting outright.
      // Added files, and files this version has never had, have no prior
      // state to protect, so a direct copy is correct and unambiguous.
      let finalText: string | null = afterText;
      let isMerge = false;

      if (file.status === 'modified' && existingTargetText !== null && preMergeBaseSha) {
        const beforeText = await getContentAtRef(octokit, context, file.filename, preMergeBaseSha);
        if (beforeText !== null && beforeText !== afterText) {
          const patch = createPatch(file.filename, beforeText, afterText);
          const merged = applyPatch(existingTargetText, patch);
          if (merged === false) {
            core.warning(
              `Could not cleanly apply the diff for ${file.filename} onto ${targetPath}: ` +
              `its content has diverged from what this PR changed. Leaving it unchanged; ` +
              `backport this file's changes manually.`
            );
            conflicts++;
            conflictFiles.push(targetPath);
            continue;
          }
          finalText = merged;
          isMerge = true;
        }
      }

      const finalContent = encodeContent(finalText as string);
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
          sha: sha || undefined
        });
      } catch (createError: any) {
        // Check if this is a SHA conflict (file was created between check and write)
        const isShaConflict = createError.status === 409 || createError.message?.includes('but expected');
        if (isShaConflict) {
          core.info(`SHA conflict detected for ${targetPath}, retrying with current SHA...`);

          // Re-fetch the current SHA
          const { data: conflictFile } = await octokit.rest.repos.getContent({
            ...context.repo,
            path: targetPath,
            ref: branchName
          });

          // Retry with the correct SHA
          await octokit.rest.repos.createOrUpdateFileContents({
            ...context.repo,
            path: targetPath,
            message: commitMessage,
            content: finalContent,
            branch: branchName,
            sha: conflictFile.sha
          });
          core.info(`Retry successful for ${targetPath}`);
        } else {
          throw createError;
        }
      }

      copied++;
      core.info(`Backported ${file.filename} to ${targetPath}`);

      // For renamed files, also delete the old path from the versioned folder
      if (file.status === 'renamed' && file.previous_filename) {
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
