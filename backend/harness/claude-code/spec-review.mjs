// spec-review.mjs — what a spec review launch enforces on the Claude Code command line, which no
// prompt can widen, and the MCP config it loads alone.
import path from 'node:path';

// What the spec review launch enforces on the command line, which no prompt can widen. The built-in
// tools are only these (no Bash, Edit, Write, Grep, Glob, WebFetch or Agent), so the `Read` deny rules
// are the only file limit. The deny list is an explicit list of named toolkit write tools and `Read`
// paths, not an exhaustive one: reads inside the working directory are otherwise unrestricted. The read
// tools, `github_submit_pr_review` and the Slack prepare and confirm pair stay allowed. Other launches
// get none of these flags.
const LIMITS = {
  tools: ['Read', 'Skill', 'ToolSearch'],
  disallowedTools: [
    'mcp__toolkit-mcp__github_add_pr_comment',
    'mcp__toolkit-mcp__github_create_pr',
    'mcp__toolkit-mcp__github_create_pr_review_comment',
    'mcp__toolkit-mcp__github_delete_pr_issue_comment',
    'mcp__toolkit-mcp__github_delete_pr_review_comment',
    'mcp__toolkit-mcp__github_dismiss_pr_review',
    'mcp__toolkit-mcp__github_merge_pr',
    'mcp__toolkit-mcp__github_request_pr_reviewers',
    'mcp__toolkit-mcp__github_resolve_review_thread',
    'mcp__toolkit-mcp__github_unresolve_review_thread',
    'mcp__toolkit-mcp__github_update_pr',
    'mcp__toolkit-mcp__github_update_pr_assignees',
    'mcp__toolkit-mcp__github_update_pr_comment',
    'mcp__toolkit-mcp__github_update_pr_labels',
    'mcp__toolkit-mcp__github_update_pr_review_comment',
    'mcp__toolkit-mcp__jira_add_comment',
    'mcp__toolkit-mcp__jira_assign_issue',
    'mcp__toolkit-mcp__jira_create_issue',
    'mcp__toolkit-mcp__jira_delete_comment',
    'mcp__toolkit-mcp__jira_link_issues',
    'mcp__toolkit-mcp__jira_transition_issue',
    'mcp__toolkit-mcp__jira_update_comment',
    'mcp__toolkit-mcp__jira_update_issue',
    'mcp__toolkit-mcp__confluence_create_page',
    'mcp__toolkit-mcp__confluence_update_page',
    'mcp__toolkit-mcp__figma_post_comment',
    'mcp__toolkit-mcp__slack_login',
    'mcp__toolkit-mcp__slack_logout',
    'Read(~/.config/**)',
    'Read(~/.ssh/**)',
    'Read(~/.aws/**)',
    'Read(~/.claude.json)',
    'Read(**/.env*)',
    'Read(**/config.json)',
    'Read(**/config.json.*)',
    'Read(**/.mcp.json)',
    'Read(**/*.sql)',
    'Read(./.worktrees/**)',
    'Read(./.corpus_runs/**)',
    'Read(~/.claude/.credentials.json)',
    'Read(~/.claude/projects/**)',
    'Read(~/.claude/history.jsonl)',
    'Read(~/.bash_history*)',
    'Read(~/.local/share/**)',
    'Read(~/.git-credentials)',
    'Read(~/.npmrc)',
    'Read(~/.netrc)',
    'Read(~/.docker/**)',
    'Read(~/.gnupg/**)',
    'Read(//ezat/**)',
    'Read(**/*.csv)',
    'Read(./TravelTracker/files/**)',
    'Read(**/.playwright/**)',
    'Read(./.playwright-mcp/**)',
    'Read(**/cypress.env.json)',
    'Read(**/auth.json)',
  ],
};

// The launch directory's MCP config, loaded alone (`--strict-mcp-config`): the servers it names.
export const specReview = ({ launchDirectory }) => ({
  ...LIMITS,
  mcpConfig: path.join(launchDirectory, '.mcp.json'),
});
