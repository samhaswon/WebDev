#!/usr/bin/env node
/* build-assets.js
 * Prebuild optimized assets into ./cache mirroring ../BakerySite, then exit.
 */

const CleanCSS = require('clean-css');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('path');
const nunjucks = require('nunjucks');
const { minify: minifyHtml } = require('html-minifier-terser');
const Terser = require('terser');
const sharp = require('sharp');

const ROOT = __dirname;
const SITE_DIR = path.resolve(ROOT, '../BakerySite');
const CACHE_DIR = path.resolve(ROOT, 'cache');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.jfif']);
const JS_EXT = '.js';
const CSS_EXT = '.css';
const HTML_EXT = '.html';

const cssMinifier = new CleanCSS({
    level: 2,
    returnPromise: true,
    inline: false,
    rebase: false,
    sourceMap: false,
    compatibility: '*',
    properties: { shorterLengthUnits: true }
});

nunjucks.configure(SITE_DIR, { autoescape: true });

function log(msg) {
    process.stdout.write(`${msg}\n`);
}

async function rimraf(dir) {
    try {
        await fsp.rm(dir, { recursive: true, force: true });
    } catch (_) {}
}

async function ensureDir(p) {
    await fsp.mkdir(p, { recursive: true });
}

async function* walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}

function relToSite(absPath) {
    return path.relative(SITE_DIR, absPath).split(path.sep).join('/');
}

async function buildHtml(srcAbs) {
    const rel = relToSite(srcAbs);
    const outAbs = path.join(CACHE_DIR, rel);
    await ensureDir(path.dirname(outAbs));

    // Render via nunjucks using absolute path to keep your server behavior
    const rendered = nunjucks.render(srcAbs);
    const minified = await minifyHtml(rendered, {
        caseSensitive: true,
        collapseWhitespace: true,
        conservativeCollapse: true,
        continueOnParseError: true,
        minifyCSS: true,
        minifyJS: true,
        removeComments: true,
        removeEmptyElements: false
    });

    await fsp.writeFile(outAbs, minified, 'utf-8');
    log(`HTML  → ${rel}`);
}

async function buildJs(srcAbs) {
    const rel = relToSite(srcAbs);
    // Skip already minified files
    if (/\.min\.js$/i.test(rel)) {
        const outAbs = path.join(CACHE_DIR, rel);
        await ensureDir(path.dirname(outAbs));
        await fsp.copyFile(srcAbs, outAbs);
        log(`JS(cp) → ${rel}`);
        return;
    }

    const code = await fsp.readFile(srcAbs, 'utf-8');
    const result = await Terser.minify(code, {
        compress: true,
        mangle: true,
        ecma: 2019
    });

    if (result.error) {
        throw new Error(`Terser error in ${rel}: ${result.error.message || result.error}`);
    }

    const outAbs = path.join(CACHE_DIR, rel);
    await ensureDir(path.dirname(outAbs));
    await fsp.writeFile(outAbs, result.code, 'utf-8');
    log(`JS    → ${rel}`);
}

async function buildCss(srcAbs) {
    const rel = relToSite(srcAbs);
    // Skip already minified files
    if (/\.min\.css$/i.test(rel)) {
        const outAbs = path.join(CACHE_DIR, rel);
        await ensureDir(path.dirname(outAbs));
        await fsp.copyFile(srcAbs, outAbs);
        log(`CSS(cp) → ${rel}`);
        return;
    }

    const code = await fsp.readFile(srcAbs, 'utf-8');
    const result = await cssMinifier.minify(code);
    if (result.errors && result.errors.length) {
        throw new Error(`CleanCSS error in ${rel}: ${result.errors[0]}`);
    }
    const outAbs = path.join(CACHE_DIR, rel);
    await ensureDir(path.dirname(outAbs));
    await fsp.writeFile(outAbs, result.styles, 'utf-8');
    log(`CSS   → ${rel}`);
}

async function buildImage(srcAbs) {
    const rel = relToSite(srcAbs);
    const parsed = path.parse(rel);
    const outRel = path.join(parsed.dir, `${parsed.name}${parsed.ext === '.webp' ? '' : ''}.webp`);
    const outAbs = path.join(CACHE_DIR, outRel);
    await ensureDir(path.dirname(outAbs));

    await sharp(srcAbs)
        .webp({ quality: 80 })
        .toFile(outAbs);

    log(`IMG   → ${outRel}`);
}

async function copyAsset(srcAbs) {
    const rel = relToSite(srcAbs);
    const outAbs = path.join(CACHE_DIR, rel);
    await ensureDir(path.dirname(outAbs));
    await fsp.copyFile(srcAbs, outAbs);
    log(`COPY  → ${rel}`);
}

async function main() {
    log(`Site: ${SITE_DIR}`);
    log(`Out:  ${CACHE_DIR}`);
    await rimraf(CACHE_DIR);
    await ensureDir(CACHE_DIR);

    const tasks = [];
    for await (const abs of walk(SITE_DIR)) {
        const ext = path.extname(abs).toLowerCase();

        if (ext === HTML_EXT) {
            tasks.push(buildHtml(abs));
        } else if (ext === JS_EXT) {
            tasks.push(buildJs(abs));
        } else if (ext === CSS_EXT) {
            tasks.push(buildCss(abs));
        } else if (IMAGE_EXTS.has(ext)) {
            tasks.push(buildImage(abs));
        } else {
            // Copy other assets (fonts, svg, ico, json, etc.)
            tasks.push(copyAsset(abs));
        }

        // Batch to keep memory reasonable on very large trees
        if (tasks.length >= 50) {
            await Promise.all(tasks.splice(0, tasks.length));
        }
    }

    if (tasks.length) {
        await Promise.all(tasks);
    }

    log('Build complete.');
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
