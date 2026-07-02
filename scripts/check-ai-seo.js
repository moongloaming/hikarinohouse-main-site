#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

let failures = 0;

function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${message}`);
  } else {
    console.log(`PASS ${message}`);
  }
}

function hasJsonLdType(html, type) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return scripts.some((match) => match[1].includes(`"@type":"${type}"`) || match[1].includes(`"@type": "${type}"`));
}

function hasMeta(html, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<meta\\s+${attribute}="${escaped}"\\s+content="[^"]+"`, "i").test(html);
}

const index = read("index.html");
const about = read("about.html");
const help = read("help.html");
const llms = read("llms.txt");
const sitemap = read("sitemap.xml");
const sitemapIndex = read("sitemap_index.xml");

check(index.includes('<link rel="canonical" href="https://hikarinohouse.com/">'), "homepage has canonical URL");
check(about.includes('<link rel="canonical" href="https://hikarinohouse.com/about">'), "about page has canonical URL");

for (const [label, html] of [["homepage", index], ["about page", about]]) {
  check(hasMeta(html, 'property', "og:title"), `${label} has og:title`);
  check(hasMeta(html, 'property', "og:description"), `${label} has og:description`);
  check(hasMeta(html, 'property', "og:url"), `${label} has og:url`);
  check(hasMeta(html, 'property', "og:type"), `${label} has og:type`);
  check(hasMeta(html, 'name', "twitter:card"), `${label} has twitter card`);
}

check(hasJsonLdType(index, "Organization"), "homepage has Organization JSON-LD");
check(hasJsonLdType(index, "LocalBusiness"), "homepage has LocalBusiness JSON-LD");
check(hasJsonLdType(help, "ItemList"), "help index has ItemList JSON-LD");

check(llms.includes("目前共 19 個主題頁面"), "llms.txt has correct help topic count");
// 網址一律乾淨網址（無 .html）——與 Cloudflare Workers assets 的 html_handling 行為一致
for (const topic of [
  "member-registration",
  "shipping-cost",
  "damage-lost-refund",
  "daigou-cost",
  "shipping-time",
  "b2b-sourcing",
  "taiwan-tax",
]) {
  check(llms.includes(`https://hikarinohouse.com/help/${topic})`), `llms.txt includes ${topic}`);
}

check(!llms.includes(".html"), "llms.txt has no .html URLs");
check(!sitemap.includes(".html"), "sitemap has no .html URLs");

for (const page of [
  "daigou-cost",
  "shipping-time",
  "b2b-sourcing",
  "taiwan-tax",
]) {
  check(sitemap.includes(`https://hikarinohouse.com/help/${page}<`), `sitemap includes ${page}`);
  const html = read(`help/${page}.html`);
  check(html.includes(`<link rel="canonical" href="https://hikarinohouse.com/help/${page}">`), `${page} has canonical URL`);
  check(hasJsonLdType(html, "FAQPage"), `${page} has FAQPage JSON-LD`);
  check(hasJsonLdType(html, "BreadcrumbList"), `${page} has BreadcrumbList JSON-LD`);
}

check((sitemap.match(/<lastmod>2026-07-02<\/lastmod>/g) || []).length >= 22, "sitemap dates are refreshed (clean-URL migration)");
check(sitemapIndex.includes("<lastmod>2026-07-02</lastmod>"), "sitemap index date is refreshed");

if (failures > 0) {
  console.error(`\n${failures} AI/SEO checks failed.`);
  process.exit(1);
}

console.log("\nAll AI/SEO checks passed.");
