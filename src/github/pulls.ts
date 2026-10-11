/**
 * Shared pull-request facts.
 *
 * One home for "list changed files" and "get pull request", so the two
 * consumers stop hand-rolling pagination. `listChangedFiles` walks every page
 * through `octokit.paginate` by default; a caller that passes `maxPages` gets
 * a bounded listing instead and `truncated: true` whenever the file list could
 * not be read completely, so a safety-capped consumer refuses rather than
 * deciding on partial facts.
 */

import type { Context } from "probot";

type Api = Context<"pull_request">["octokit"];

/** GitHub's maximum page size; a short page marks the last one. */
const PER_PAGE = 100;

/**
 * The subset of a changed file the callers rely on. Kept structural rather
 * than importing octokit's response type so the module owns only the fields
 * its consumers actually use.
 */
export interface ChangedFile {
  readonly filename: string;
  readonly status: string;
  /**
   * Present on a renamed file. The old location matters just as much as the
   * new one for protected-path checks.
   */
  readonly previous_filename?: string | null;
}

export interface ListChangedFilesOptions {
  /**
   * Stop after this many pages. When the last allowed page is full,
   * `truncated` is reported rather than fetching a further page.
   */
  readonly maxPages?: number;
}

export interface ChangedFiles {
  readonly files: ChangedFile[];
  readonly truncated: boolean;
}

/**
 * List the files changed by a pull request.
 *
 * Without `maxPages` this walks every page through `octokit.paginate`. With a
 * cap it enumerates at most that many pages and sets `truncated: true` when
 * the final page was full — a full page under the cap means there may be more
 * we did not read.
 */
export async function listChangedFiles(
  octokit: Api,
  owner: string,
  repo: string,
  pullNumber: number,
  options: ListChangedFilesOptions = {},
): Promise<ChangedFiles> {
  const params = { owner, repo, pull_number: pullNumber, per_page: PER_PAGE };

  if (options.maxPages === undefined) {
    const files = await octokit.paginate(octokit.pulls.listFiles, params);
    return { files: files as ChangedFile[], truncated: false };
  }

  const files: ChangedFile[] = [];

  for (let page = 1; page <= options.maxPages; page += 1) {
    const { data } = await octokit.pulls.listFiles({ ...params, page });
    files.push(...(data as ChangedFile[]));

    // A short page is the last page; a full one under the cap may not be.
    if (data.length < PER_PAGE) return { files, truncated: false };
  }

  return { files, truncated: true };
}

export async function getPullRequest(
  octokit: Api,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  return data;
}
