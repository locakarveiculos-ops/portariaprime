// Lighthouse real (mobile simulado) da landing, servindo o build com gzip como a Vercel.
//   node tests/lighthouse.mjs [url]   → tests/evidence/lighthouse/landing.{html,json} + resumo
import { writeFileSync, mkdirSync } from 'node:fs';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';

const url = process.argv[2] || 'http://127.0.0.1:4174/';
const chrome = await launch({ chromeFlags: ['--headless=new'] });
try {
  const r = await lighthouse(url, { port: chrome.port, output: ['html', 'json'], onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] });
  mkdirSync('tests/evidence/lighthouse', { recursive: true });
  writeFileSync('tests/evidence/lighthouse/landing.report.html', r.report[0]);
  writeFileSync('tests/evidence/lighthouse/landing.report.json', r.report[1]);
  const lhr = r.lhr;
  for (const [k, v] of Object.entries(lhr.categories)) console.log(`${k}: ${Math.round(v.score * 100)}`);
  for (const a of ['first-contentful-paint', 'largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time']) console.log(`${a}: ${lhr.audits[a].displayValue}`);
  const refs = ['accessibility', 'seo', 'best-practices'].flatMap((c) => lhr.categories[c].auditRefs.map((x) => x.id));
  const fails = refs.filter((id) => lhr.audits[id].score !== null && lhr.audits[id].score < 1 && lhr.audits[id].scoreDisplayMode === 'binary');
  console.log(`falhas a11y/seo/práticas: ${fails.join(', ') || 'nenhuma'}`);
} finally { await chrome.kill(); }
