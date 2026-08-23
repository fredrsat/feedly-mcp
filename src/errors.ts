/**
 * Error taxonomy from spec §6.
 *
 * Every failure the user can plausibly hit gets a named code and a message that
 * says what to do about it. Nothing here ever contains the token — see
 * `redact()`, which is applied to anything originating outside our own strings.
 */

export type ErrorCode =
  | "token_missing"
  | "token_expired"
  | "token_file_permissions"
  | "rate_limited"
  | "budget_exhausted"
  | "out_of_scope"
  | "writes_disabled"
  | "folder_not_found"
  | "config_invalid"
  | "network_error"
  | "feedly_error";

export interface ErrorDetails {
  /** Seconds until the Feedly quota resets, when known. */
  resetSeconds?: number;
  /** Calls used / allowed, when known. */
  used?: number;
  limit?: number;
  /** HTTP status, for feedly_error. */
  status?: number;
  [key: string]: unknown;
}

export class FeedlyMcpError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "FeedlyMcpError";
    this.code = code;
    this.details = details;
  }

  /** Shape returned to the agent. Never includes a stack trace. */
  toToolResult(): { error: ErrorCode; message: string; details?: ErrorDetails } {
    const out: { error: ErrorCode; message: string; details?: ErrorDetails } = {
      error: this.code,
      message: this.message,
    };
    if (Object.keys(this.details).length > 0) out.details = this.details;
    return out;
  }
}

const TOKEN_RENEWAL_URL = "https://feedly.com/v3/auth/dev";

export const errors = {
  tokenMissing: (searched: string[]) =>
    new FeedlyMcpError(
      "token_missing",
      `No Feedly token found. Set the FEEDLY_TOKEN environment variable, or ` +
        `write the token to a file and point feedly.token_file at it. ` +
        `Looked in: ${searched.join(", ")}. Get a token at ${TOKEN_RENEWAL_URL}`,
    ),

  tokenExpired: () =>
    new FeedlyMcpError(
      "token_expired",
      `Feedly rejected the token (HTTP 401). Developer tokens expire — on a free ` +
        `account after about 30 days. Generate a new one at ${TOKEN_RENEWAL_URL} ` +
        `and update FEEDLY_TOKEN (or your token file).`,
    ),

  tokenFilePermissions: (path: string, mode: string) =>
    new FeedlyMcpError(
      "token_file_permissions",
      `Token file ${path} has mode ${mode}; it must be readable only by you. ` +
        `Fix it with: chmod 600 ${path}`,
    ),

  rateLimited: (resetSeconds?: number, limit?: number) =>
    new FeedlyMcpError(
      "rate_limited",
      `Feedly's daily API quota is exhausted (HTTP 429)${
        limit ? `; the account's ceiling is ${limit} calls/day` : ""
      }. ${
        resetSeconds !== undefined
          ? `It resets in ${formatDuration(resetSeconds)}.`
          : "It resets on Feedly's daily schedule."
      } Not retrying — retrying would only extend the block.`,
      { ...(resetSeconds !== undefined && { resetSeconds }), ...(limit !== undefined && { limit }) },
    ),

  /**
   * `used` is the account-wide figure from Feedly's own header, which counts
   * every client — including Feedly in the user's browser. `byThisServer` is how
   * much of it we are responsible for. Saying only the first would wrongly imply
   * this server spent it all.
   */
  budgetExhausted: (
    which: "daily" | "session",
    used: number,
    limit: number,
    byThisServer?: number,
  ) =>
    new FeedlyMcpError(
      "budget_exhausted",
      which === "daily"
        ? `The daily ceiling of ${limit} calls is reached: the account has used ` +
          `${used} today${
            byThisServer !== undefined
              ? `, ${byThisServer} of them through this server`
              : ""
          }. The count is account-wide, so reading Feedly in a browser spends it ` +
          `too. This ceiling is feedly-mcp's own — raise budget.daily_calls to go ` +
          `further, up to whatever Feedly actually allows.`
        : `This session's call budget is spent (${used}/${limit} calls). This guards ` +
          `against one conversation draining the whole day. Start a new session, or ` +
          `raise budget.session_calls.`,
      { used, limit, ...(byThisServer !== undefined && { byThisServer }) },
    ),

  outOfScope: (folder: string) =>
    new FeedlyMcpError(
      "out_of_scope",
      `The folder "${folder}" is outside the configured scope, so this server ` +
        `cannot read it. Add it to scope.include_folders, or clear that list to ` +
        `allow every folder.`,
    ),

  /**
   * Naming only the TOML key sent a user hunting in the wrong file, so spell out
   * both mechanisms and where each one lives.
   */
  writesDisabled: (bulk: boolean) =>
    new FeedlyMcpError(
      "writes_disabled",
      (bulk
        ? `Marking a whole folder read is disabled. It is permanent and can affect ` +
          `thousands of articles at once, so it needs BOTH switches on.`
        : `Marking articles read is disabled. Feedly has no undo for this, so it is ` +
          `off by default.`) +
        ` Enable it either in ~/.config/feedly-mcp/config.toml:\n` +
        `    [writes]\n    enabled = true\n` +
        (bulk ? `    bulk_mark_read = true\n` : "") +
        `  ...or as environment variables in your MCP client's "env" block:\n` +
        `    FEEDLY_MCP_WRITES_ENABLED=true` +
        (bulk ? `, FEEDLY_MCP_WRITES_BULK_MARK_READ=true` : "") +
        `\n  A .env file in the repository is NOT read by the server — that file is ` +
        `only for the development scripts. Run "doctor" to see which values are ` +
        `actually in effect and where each came from.`,
    ),

  folderNotFound: (folder: string, available: string[]) =>
    new FeedlyMcpError(
      "folder_not_found",
      `No folder matches "${folder}". Available: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }`,
    ),

  configInvalid: (message: string) => new FeedlyMcpError("config_invalid", message),

  network: (cause: string) =>
    new FeedlyMcpError(
      "network_error",
      `Could not reach Feedly: ${cause}. Check your connection; if you are running ` +
        `inside a sandbox, confirm api.feedly.com is reachable from it.`,
    ),

  feedly: (status: number, body: string) =>
    new FeedlyMcpError("feedly_error", `Feedly returned HTTP ${status}: ${truncate(body, 200)}`, {
      status,
    }),
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Belt and braces: strip anything that looks like the live token out of a string
 * before it reaches a log, a tool result, or an error message.
 */
export function redact(text: string, token: string | undefined): string {
  if (!token || token.length < 8) return text;
  return text.split(token).join("<token redacted>");
}
