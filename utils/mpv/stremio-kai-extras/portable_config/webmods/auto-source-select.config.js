/**
 * AUTO SOURCE SELECT - user config
 *
 * Read by UI/auto-source-select.js when a streams page opens. Edit, save, then
 * RESTART Stremio (webmods are loaded once per session). A syntax error here
 * leaves the feature switched off and Settings > Player > Auto Source Select
 * shows "config not loaded".
 *
 * Every key is optional - anything missing falls back to the built-in default,
 * which is the value shown here.
 *
 * Tip: open DevTools on a streams page and run  AutoSourceSelect.dryRun()
 * to print the ranked list without playing anything.
 */
window.__autoSourceSelectConfig = {
  // Master switch in this file. The toggle in Settings must ALSO be on.
  enabled: true,

  // console.log the ranked candidates every time a pick is made.
  debug: false,

  // ── Timing ────────────────────────────────────────────────────────────────
  // Addons answer at different speeds, so the picker waits before deciding.
  // It decides as soon as the FIRST of these happens:
  //   - the web UI's "N addons are still loading" banner is gone (everything answered)
  //   - every addon in `addons` below has at least one stream AND the list has
  //     been quiet for `settleSeconds`
  //   - nothing new has arrived for `idleSeconds` (covers a configured addon that
  //     returns no streams for this title - it never shows up in the list at all)
  //   - `maxWaitSeconds` has passed since the page opened
  maxWaitSeconds: 15,
  settleSeconds: 1.5,
  idleSeconds: 5, // 0 = never decide on idle alone

  // Seconds the toast counts down before playing. 0 = play immediately.
  countdownSeconds: 5,

  // ── Priority order ────────────────────────────────────────────────────────
  // Criteria are compared strictly in this order: every stream from a better
  // addon beats every stream from a worse one; only among equal addons does
  // quality matter, and so on. Reorder to taste, e.g.
  //   ["size", "quality", "addon", "language"]
  // means "within the ideal size first, then best quality, then best addon".
  // Valid entries: "addon", "quality", "language", "size".
  priority: ["addon", "quality", "language", "size"],

  // ── Addons ────────────────────────────────────────────────────────────────
  // Only streams matching one of these entries are ever picked; position is the
  // rank. Two regexes per entry:
  //   addon  - tested against the addon's manifest name (the row's tooltip,
  //            e.g. "Torrentio TB"). Used to know whether that addon has
  //            answered yet.
  //   match  - tested against the first line of the stream name shown in the
  //            row (e.g. "[TB+] Torrentio"). Used to decide if the row is
  //            eligible - this is how "[TB+]" (cached) is kept and
  //            "[TB download]" (not cached) is dropped.
  addons: [
    { name: "Torrentio TB+",  addon: /^Torrentio TB$/i, match: /^\[TB\+\]\s*Torrentio/i },
    { name: "Torrentio AD+",  addon: /^Torrentio AD$/i, match: /^\[AD\+\]\s*Torrentio/i },
    { name: "Jackettio TB⚡", addon: /^Jackettio/i,     match: /^\[TB⚡\]\s*Jackettio/i },
  ],

  // ── Quality ───────────────────────────────────────────────────────────────
  // Rank order. Anything not listed ("rest": 480p, unknown, ...) ranks last,
  // higher resolution first within it. Known tiers: "4K", "1080p", "720p".
  quality: ["1080p", "4K", "720p"],

  // ── Language ──────────────────────────────────────────────────────────────
  // First entry that matches wins. An entry matches when ANY of its `flags`
  // appears in the stream's language line, OR any of its `keywords` appears as
  // a whole word in the release title (case-insensitive).
  //
  // Torrentio shows every Indian language as 🇮🇳, so Malayalam / Hindi cannot be
  // told apart by flag - they rely on the title ("Mal", "Malayalam", "Hin"...).
  // A stream whose only flag is 🇮🇳 and whose title has no keyword lands in
  // "rest".
  languages: [
    { name: "Malayalam", flags: [],            keywords: ["mal", "malayalam"] },
    { name: "English",   flags: ["🇬🇧", "🇺🇸"], keywords: ["eng", "english"] },
    { name: "Hindi",     flags: [],            keywords: ["hin", "hindi"] },
  ],

  // Streams with no language information at all (no flags, no keywords) are
  // usually plain English releases. Name an entry above, or null for "rest".
  unknownLanguageAs: "English",

  // ── Size ──────────────────────────────────────────────────────────────────
  // Hard cap: anything larger is never picked.
  maxSizeGB: 20,

  // Ideal range per content type, in GB. A stream inside the range ranks above
  // one outside it; among out-of-range streams the closest wins. Streams with
  // no size shown count as out of range.
  idealSizeGB: {
    movie:  [2, 3.5],
    series: [0, 1.5],
  },

  // Rows whose release title matches any of these are dropped outright.
  // Cinema rips are listed by default; remove that line if you want them.
  excludeKeywords: [
    /\btrailer\b/i,
    /\bsample\b/i,
    /\b(cam|hdcam|camrip|hdts|telesync|telecine)\b/i,
  ],

  // ── Wishes tried first ────────────────────────────────────────────────────
  // Each rule is a filter. Rules are tried in order; the first one that leaves
  // at least one stream wins, and the best stream inside it is chosen using
  // `priority` (or the rule's own `priority`). If no rule matches anything the
  // normal ranking above is used.
  //
  // Fields (all optional, all must hold):
  //   addons:     ["Torrentio TB+", ...]   names from `addons`
  //   quality:    ["4K", "1080p", ...]     tiers
  //   languages:  ["Malayalam", ...]       names from `languages`
  //   minSizeGB / maxSizeGB / minSeeders:  numbers
  //   match:      /regex/i                 against the release title
  //   priority:   [...]                    overrides the global order inside this rule
  //
  // Examples:
  //   { quality: ["4K"], maxSizeGB: 3 },                       // small 4K if one exists
  //   { languages: ["Malayalam"], quality: ["1080p", "4K"] },  // Malayalam HD above all
  preferFirst: [],

  // Note: if an external player is configured in Stremio's own settings the
  // stream rows stop linking to the built-in player and nothing can be
  // auto-selected.
};
