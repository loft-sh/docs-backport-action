import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'path';

// Define main folders and their versioned counterparts
const FOLDER_MAPPING: Record<string, string> = {
  'platform': 'platform_versioned_docs',
  'vcluster': 'vcluster_versioned_docs'
};

// Regular expression to match version labels (e.g., backport-v0.22, backport-v4.2)
const VERSION_LABEL_REGEX = /^backport-v([\d\.]+)$/;

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
    if (context.payload.action === 'labeled') {
      const addedLabel = context.payload.label?.name || '';
      if (!addedLabel.match(VERSION_LABEL_REGEX)) {
        core.info(`Added label "${addedLabel}" is not a backport label, skipping`);
        return;
      }
      
      // Only process label events if the PR is already merged
      if (!merged) {
        core.info('PR is labeled but not merged yet, skipping backport until merge');
        return;
      }
    }
    
    // If not merged and not a label event, skip
    if (!merged && context.payload.action !== 'labeled') {
      core.info('PR not merged and not a label event, skipping');
      return;
    }
    
    // Extract version labels
    const versionLabels = labels
      .map((label: GitHubLabel) => {
        const match = label.name.match(VERSION_LABEL_REGEX);
        return match ? match[1] : null;
      })
      .filter((v: string | null) => v !== null) as string[];
    
    if (versionLabels.length === 0) {
      core.info('No version labels found, skipping backport');
      return;
    }
    
    // Get changed files from the PR
    const { data: files } = await octokit.rest.pulls.listFiles({
      ...context.repo,
      pull_number: prNumber
    });
    
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
      
      // Only create a PR if we successfully copied at least one file
      if (stats.copied > 0) {
        // Create a PR
        await createBackportPR(
          octokit, 
          context, 
          branchName, 
          targetMainFolder, 
          version, 
          prNumber
        );
      } else {
        core.info(`No files were successfully copied for ${targetMainFolder} to version ${version}, skipping PR creation`);
      }
    }
    
  } catch (error: any) {
    core.setFailed(`Action failed: ${error.message}`);
  }
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
  skipped: number;
  errors: number;
}

async function backportFiles(
  octokit: any, 
  context: any, 
  sourceFolder: string, 
  versionedFolder: string, 
  files: any[], 
  branchName: string
): Promise<BackportStats> {
  // Track stats for reporting
  let copied = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const file of files) {
    try {
      // Extract the relative path within the source folder
      const relativePath = file.filename.substring(sourceFolder.length + 1);
      
      // Skip if file was deleted in the PR
      if (file.status === 'removed') {
        core.info(`Skipping deleted file: ${file.filename}`);
        skipped++;
        continue;
      }
      
      // Construct the target path in the versioned folder
      // For your structure, we need to copy to version-vX.Y.Z/[original path]
      const targetPath = `${versionedFolder}/${relativePath}`;
      
      core.info(`Backporting ${file.filename} to ${targetPath}`);
      
      // Get the file content from the PR's head branch
      const { data: content } = await octokit.rest.repos.getContent({
        ...context.repo,
        path: file.filename,
        ref: context.payload.pull_request.head.sha
      });
      
      // Check if the target file already exists to get its SHA
      let sha = '';
      try {
        const { data: existingFile } = await octokit.rest.repos.getContent({
          ...context.repo,
          path: targetPath,
          ref: branchName
        });
        sha = existingFile.sha;
      } catch (error) {
        // File doesn't exist yet, which is fine
        core.info(`Target file doesn't exist yet, will create: ${targetPath}`);
      }
      
      // Create or update the file in the versioned folder
      await octokit.rest.repos.createOrUpdateFileContents({
        ...context.repo,
        path: targetPath,
        message: `Backport: Copy ${file.filename} to ${targetPath}`,
        content: typeof content.content === 'string' ? content.content : Buffer.from(content.content).toString('base64'),
        branch: branchName,
        sha: sha || undefined
      });
      
      copied++;
      core.info(`Backported ${file.filename} to ${targetPath}`);
    } catch (error: any) {
      errors++;
      core.warning(`Error backporting file ${file.filename}: ${error.message}`);
    }
  }
  
  // Create stats object
  const stats: BackportStats = {
    copied,
    skipped,
    errors
  };
  
  core.info(`Backport stats - Copied: ${copied}, Skipped: ${skipped}, Errors: ${errors}`);
  
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
    // Search for open PRs that mention the original PR number and have relevant title/labels
    const { data: openPRs } = await octokit.rest.pulls.list({
      ...context.repo,
      state: 'open',
      sort: 'created',
      direction: 'desc'
    });

    // Look for PRs with title mentioning backport to this version and body referencing original PR
    for (const pr of openPRs) {
      const matchesTitle = pr.title.includes(`${mainFolder} changes to v${version}`);
      const referencesOriginalPR = pr.body && pr.body.includes(`Original PR: #${originalPRNumber}`);
      
      if (matchesTitle && referencesOriginalPR) {
        return pr;
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
  originalPRNumber: number
): Promise<void> {
  // Create a PR
  const { data: pr } = await octokit.rest.pulls.create({
    ...context.repo,
    title: `Backport: ${mainFolder} changes to v${version}`,
    body: `This PR backports changes from ${mainFolder} to version v${version}.\n\nOriginal PR: #${originalPRNumber}`,
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

run();
