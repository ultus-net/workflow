# Impeccable critique ignore list (previous-run findings to drop)

- `side-tab` on `src/ui/webapp/styles.css` `.aui-md blockquote` (border-left on
  markdown blockquotes) — false positive: border-left is the standard markdown
  renderer convention for quoted blocks (GitHub et al.), not a decorative
  side-tab card. Confirmed false positive in two independent critique runs.
