// En desarrollo la CSP necesita ws: (HMR) y 'unsafe-inline' (estilos inyectados por Vite).
// En producción se endurece quitando ambos.
const hardenCsp = {
  name: 'harden-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(' ws:', '').replace("style-src 'self' 'unsafe-inline'", "style-src 'self'"),
};

export default {
  base: './', // rutas relativas: funciona en la raíz y bajo /ScanViewer/ (GitHub Pages)
  plugins: [hardenCsp],
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
};
