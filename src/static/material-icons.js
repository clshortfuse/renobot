// Registered before page markup upgrades, so MDW never requests an external icon font.
const materialIcons = /** @type {{ svgAlias: { addSVGAlias: (name: string, path: string) => void } }} */ (Reflect.get(globalThis, '@shortfuse/materialdesignweb'));
const portalIconPaths = {
  dashboard: 'M3 3h8v8H3zm10 0h8v5h-8zm0 7h8v11h-8zM3 13h8v8H3z',
  favorite: 'M12 21l-1.45-1.32C5.4 15.01 2 11.92 2 8.13 2 5.04 4.42 2.62 7.5 2.62c1.74 0 3.41.81 4.5 2.09a5.98 5.98 0 0 1 4.5-2.09c3.08 0 5.5 2.42 5.5 5.51 0 3.79-3.4 6.88-8.55 11.56z',
  receipt_long: 'M6 2l2 1 2-1 2 1 2-1 2 1 2-1v20l-2-1-2 1-2-1-2 1-2-1-2 1zm2 5v2h8V7zm0 4v2h8v-2zm0 4v2h6v-2z',
  verified: 'M12 2l3 2 4 .5.5 4 2 3-2 3-.5 4-4 .5-3 2-3-2-4-.5-.5-4-2-3 2-3 .5-4 4-.5zm-2 14l7-7-1.4-1.4L10 13.2l-2.6-2.6L6 12z',
  home: 'M12 3L2 12h3v9h6v-6h2v6h6v-9h3z',
  menu: 'M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z',
  refresh: 'M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.09A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h8V3z',
  download: 'M11 3h2v9h4l-5 5-5-5h4zM5 19h14v2H5z',
  arrow_drop_down: 'M7 10l5 5 5-5z',
  expand_more: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  expand_less: 'M12 8l6 6-1.41 1.41L12 10.83l-4.59 4.58L6 14z',
};
for (const [name, path] of Object.entries(portalIconPaths)) {
  materialIcons.svgAlias.addSVGAlias(name, path);
  materialIcons.svgAlias.addSVGAlias(`${name}#filled`, path);
}
