import { readFileSync } from 'node:fs';

/** @param {string} name */
const asset = (name) => readFileSync(new URL(`./static/${name}`, import.meta.url), 'utf8');

export const homePage = asset('home.html');
export const appPage = asset('app.html');
export const modderKofiPage = asset('modder-kofi.html');
export const errorPage = asset('error.html');
export const notFoundPage = asset('not-found.html');
export const siteCss = asset('site.css');
export const siteJs = asset('site.js');
