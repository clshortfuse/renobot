import { readFileSync } from 'node:fs';

/** @param {string} name */
const asset = (name) => readFileSync(new URL(`./static/${name}`, import.meta.url), 'utf8');

export const homePage = asset('home.html');
export const appPage = asset('app.html');
export const adminKofiPage = asset('admin-kofi.html');
export const adminEarlyAccessPage = asset('admin-early-access.html');
export const modderKofiPage = asset('modder-kofi.html');
export const errorPage = asset('error.html');
export const notFoundPage = asset('not-found.html');
export const siteCss = asset('site.css');
export const siteJs = asset('site.js');
export const materialJs = `${readFileSync(new URL('../node_modules/@shortfuse/materialdesignweb/dist/index.min.js', import.meta.url), 'utf8')}\n${asset('material-icons.js')}`;
