import type { Plugin } from 'vite';

/**
 * GitHub Pages serves files and nothing else: no rewrite, no server. A React
 * Router deep link (`/BitChord/album/x`) would 404, so Pages hands back its
 * `404.html`. This plugin writes one that remembers the path and sends the
 * browser to the app, and injects the matching restorer into `index.html`,
 * which puts the path back before the router reads it.
 *
 * The site itself stays static, and that is also the reason the relay can't
 * live here: a phone needs `web/relay/server.mjs` (or Cloudflare Pages) for
 * `/api/yt`, pointed at with `VITE_RELAY_BASE_URL` (docs/deploy.md).
 */
export function pagesPlugin(base: string): Plugin {
  const root = base.endsWith('/') ? base : `${base}/`;
  return {
    name: 'bitchord-github-pages',
    apply: 'build',
    // Runs before the router mounts, so the first render already has the deep link.
    transformIndexHtml(html) {
      const restore = [
        '<script>',
        '(function () {',
        "  var key = 'bitchord:redirect';",
        '  var saved = sessionStorage.getItem(key);',
        '  if (!saved) return;',
        '  sessionStorage.removeItem(key);',
        `  if (saved.indexOf(${JSON.stringify(root.slice(0, -1) || '/')}) === 0) history.replaceState(null, '', saved);`,
        '})();',
        '</script>',
      ].join('\n');
      return html.replace('</head>', `  ${restore}\n  </head>`);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '404.html',
        source: [
          '<!doctype html>',
          '<html lang="en">',
          '  <head>',
          '    <meta charset="UTF-8" />',
          '    <title>BitChord</title>',
          '    <script>',
          "      sessionStorage.setItem('bitchord:redirect', location.pathname + location.search + location.hash);",
          `      location.replace(${JSON.stringify(root)});`,
          '    </script>',
          '  </head>',
          '  <body></body>',
          '</html>',
          '',
        ].join('\n'),
      });
      // Keeps Jekyll away from the build's files (dotfiles and `_` names).
      this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });
    },
  };
}
