/**
 * Default GitHub App configuration.
 *
 * Woodhouse is a private App: each user or organisation registers their own,
 * so the server can serve several at once. This file maps environment
 * variables onto App definitions, keyed by App ID — which is what incoming
 * webhooks are matched against, via the
 * `X-GitHub-Hook-Installation-Target-ID` header.
 *
 * The default below is the single-App case and needs no editing: set APP_ID,
 * PRIVATE_KEY and WEBHOOK_SECRET and it works.
 *
 * To serve several Apps, mount your own file over this one and point
 * APPS_CONFIG_PATH at it. Because it is code rather than data, you are free to
 * use whatever variable names your secret tooling already produces:
 *
 *   module.exports = function (env) {
 *     return {
 *       [env.ORG_A_APP_ID]: {
 *         appId: parseInt(env.ORG_A_APP_ID, 10),
 *         privateKey: env.ORG_A_PRIVATE_KEY,
 *         webhookSecret: env.ORG_A_WEBHOOK_SECRET,
 *         // Optional, and worth setting when serving several tenants: this
 *         // App may then only act on these owners, regardless of the global
 *         // ALLOWED_INSTALLATION_TARGETS.
 *         allowedInstallationTargets: ["org-a"],
 *       },
 *       [env.ORG_B_APP_ID]: {
 *         appId: parseInt(env.ORG_B_APP_ID, 10),
 *         privateKey: env.ORG_B_PRIVATE_KEY,
 *         webhookSecret: env.ORG_B_WEBHOOK_SECRET,
 *         allowedInstallationTargets: ["org-b"],
 *       },
 *     };
 *   };
 *
 * Each App also supports `baselineRepo` and `label` (used in log lines).
 *
 * ---------------------------------------------------------------------------
 * The installation allowlist
 * ---------------------------------------------------------------------------
 * Every App must end up with one, from either:
 *
 *   - `allowedInstallationTargets` here, which takes precedence; or
 *   - the ALLOWED_INSTALLATION_TARGETS environment variable, used as the
 *     default for any App that does not set its own.
 *
 * Set it here and the environment variable is not needed at all. Set it in
 * neither and Woodhouse refuses to start.
 *
 * For a private App this is belt and braces: only the owning account can
 * install it, so the allowlist should never actually reject anything. It earns
 * its keep if an App is ever made public or converted to an Enterprise
 * installation, where a single App can span many organisations, and as a guard
 * against pointing the wrong credentials at the wrong tenant.
 */

module.exports = function (env) {
  return {
    [env.APP_ID]: {
      appId: parseInt(env.APP_ID, 10),
      privateKey: env.PRIVATE_KEY,
      webhookSecret: env.WEBHOOK_SECRET,

      // Setting this makes ALLOWED_INSTALLATION_TARGETS unnecessary.
      // allowedInstallationTargets: ["my-user", "my-org"],
    },
  };
};
