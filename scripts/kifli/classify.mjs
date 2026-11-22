#!/usr/bin/env node
/**
 * Classify cached kifli.hu recipes as pescatarian / optional-meat / meat-main.
 *
 *   node scripts/kifli/classify.mjs [--ids-file scripts/data-raw/kifli/catalog-ids.txt]
 *                                   [--overrides scripts/data-raw/kifli/catalog-overrides.json]
 *                                   [--out scripts/data-raw/kifli/catalog-classes.json]
 *
 * Reads scripts/data-raw/kifli/raw/<id>.json for every id and scans the Hungarian
 * ingredient lines (plus the name and method steps) with a meat lexicon:
 *
 * - pescatarian: no meat, poultry, game, offal, animal gelatin, lard or meat stock
 *   (fish, seafood, eggs and dairy are fine);
 * - optional-meat: every meat line is swappable (meat stock → vegetable stock, lard or
 *   duck fat → olive oil, gelatin → agar) or marked optional / garnish / topping / a
 *   variant, so the dish imports with the meat removed;
 * - meat-main: meat is a main component (named in the title, or a substantial amount).
 *
 * Anything the rules cannot settle is flagged `review: true` with a rule class; a manual
 * decision in the overrides file ({ "<id>": { "class": …, "reason": … } }) wins. An
 * unqualified "alaplé" counts as vegetable stock. Authors named "Kifli Kukták" are
 * recorded as `authorType: "ai"`, everyone else as "human".
 *
 * Progress and the summary go to stderr; stdout gets one summary JSON line.
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KIFLI = path.join(ROOT, 'scripts/data-raw/kifli');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const exists = (p) => access(p).then(() => true, () => false);

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
};

/** Meat stems, matched as substrings of the lower-cased line (Hungarian compounds freely). */
const MEAT = [
  'csirke', 'pulyka', 'kacsa', 'liba', 'tyúk', 'jérce', 'fürj', 'fácán', 'galamb', 'strucc', 'szárnyas',
  'sertés', 'disznó', 'malac', 'marha', 'borjú', 'bárány', 'birka', 'kecskehús', 'gida', 'nyúl', 'vadhús',
  'vaddisznó', 'szarvas', 'őzhús', 'őzcomb', 'őzgerinc', 'sonka', 'szalonna', 'bacon', 'kolbász', 'virsli',
  'szalámi', 'salami', 'pancetta', 'prosciutto', 'guanciale', 'chorizo', 'mortadella', 'speck', 'pastrami',
  'párizsi', 'felvágott', 'kenőmájas', 'májkrém', 'pástétom', 'hurka', 'tepertő', 'töpörtyű', 'csülök',
  'oldalas', 'karaj', 'tarja', 'dagadó', 'lapocka', 'szűzpecsenye', 'szűzérme', 'hátszín', 'bélszín',
  'rostélyos', 'fartő', 'lábszár', 'comb', 'mell', 'szárny', 'zúza', 'máj', 'velő', 'pacal', 'nyelv',
  'vese', 'csont', 'húsleves', 'csontlé', 'erőleves', 'alaplé', 'leveskocka', 'zselatin', 'zsír', 'faggyú',
  'hús', 'fasírt', 'steak', 'burger', 'gyros', 'kebab', 'pecsenye', 'darált', 'pulled pork', 'húsgombóc',
  'kakas', 'gerinc', 'demi-glace', 'fond', 'pörc', 'sertészsír', 'gyomor', 'szív', 'here',
];

/** Phrases that contain a meat stem but are not meat; removed before matching. */
const NOT_MEAT = [
  /halhús\w*/g, /rákhús\w*/g, /kókusz\w*hús\w*/g, /húsos paradicsom\w*/g, /húsparadicsom\w*/g, /\bhús[aá](?:t|val|ból|nak)?\b/g, /szív\s*alak\w*/g, /szív\s*formá?\w*/g,
  /\bhúsú\b/g, /húsmentes\w*/g, /tökhús\w*/g, /dinnyehús\w*/g, /gyümölcshús\w*/g, /avokádóhús\w*/g, /\w*gomba\w*hús\w*/g,
  /báránysaláta\w*/g, /bárányhimlő/g, /kecskesajt\w*/g, /kecsketej\w*/g, /kecsketúró\w*/g, /nyúlós\w*/g,
  /fürjtojás\w*/g, /fürj tojás\w*/g, /őzgerinc ?forma\w*/g, /őzgerincforma\w*/g, /vesebab\w*/g, /csonthéjas\w*/g,
  /zsírszegény\w*/g, /zsírtartal\w*/g, /zsírmentes\w*/g, /zsírsav\w*/g, /zsírpapír\w*/g, /\w*zsiradék\w*/g,
  /alacsony zsír\w*/g, /teljes zsír\w*/g, /\bfélzsír\w*/g, /zsírszegény/g, /\w*szénhidrát\w*/g,
  /május\w*/g, /húsvét\w*/g, /zöldség\w*[\s-]*alaplé\w*/g, /zöldség\w*[\s-]*leves\w*/g, /gomba\w*[\s-]*alaplé\w*/g, /hal\w*[\s-]*alaplé\w*/g,
  /(?:vegán|vega|növényi|szója|szójás|vegetáriánus)\s*\w*\s*(?:darált\s*hús|darálthús|hús\w*|kolbász\w*|sonka\w*|szalonna\w*|bacon\w*|csirke\w*|virsli\w*|szalámi\w*|burger\w*|fasírt\w*)/g, /szójagranul\w*/g,
  /felvágott(?=\s+[a-záéíóöőúüű])/g, /\w*hagyma\w*\s*alaplé/g,
  /vegán \w*alaplé\w*/g, /növényi \w*alaplé\w*/g, /zöldségleveskocka\w*/g, /zöldség\w*kocka\w*/g, /növényi zselatin\w*/g,
  /agar\w*/g, /mellett/g, /mellé\w*/g, /\bmell(?:é|ett)\b/g, /szívesen/g, /szívószál\w*/g, /szívecské\w*/g,
  /\w*(?:karfiol|zeller|gomba|tök|padlizsán|brokkoli|kel|hal|lazac|tonhal|cékla|kardhal|portobello)steak\w*/g,
  /\w*(?:zöldség|lencse|csicseri\w*|bab|hal|lazac|tonhal|gomba|cékla|répa|brokkoli|tofu|tök|karfiol|spenót|quinoa|köles)fasírt\w*/g,
  /\w*(?:zöldség|vega|vegán|hal|lazac|tonhal|gomba|bab|cékla|halloumi|tofu|csicseri\w*|lencse|portobello|rák|garnéla)burger\w*/g,
  /burgonya\w*/g, /burgundi\w*/g, /\bburger ?zsemle\w*/g, /\bburger ?buci\w*/g, /hamburgerzsemle\w*/g,
  /\bherb\w*/g, /herefordi/g, /\bhere\w+/g, /sonkaszirom/g, /gerinces/g, /vaddisznó ?forma/g,
  /fondü\w*/g, /fondant\w*/g, /\bfondue\w*/g, /comb ?forma/g, /szívós\w*/g, /oliva\w*/g,
  /csontozott hal\w*/g, /szálkátlan\w*/g, /máj(?:us|á)\w*/g, /karaj(?:os)? ?(?:alakú|forma)/g,
  /nyelvű/g, /nyelvecsk\w*/g, /tejszín/g, /gerezd\w*/g, /\w*mellé/g, /\bmell\w*ett/g, /zsírosbödön/g,
];

/** Seafood / fish words: a "steak"/"burger"/"fasírt" line naming one of these is not meat. */
const SEAFOOD = /hal|lazac|tonhal|garnela|\brak|kagyló|polip|tintahal|szardella|szardínia|makrela|pisztrang|ponty|harcsa|tőkehal|hering|kaviar|osztriga|homar|süllő|keszeg|busa|angolna|szurimi/;

const SWAP_BROTH = /húsleves|csontle|csontleves|erőleves|alaple|leveskocka|\bfond\b|demi-glace|etelízesítő/;
const SWAP_FAT = /zsír|faggyú/;
const SWAP_GEL = /zselatin/;
const OPTIONAL = /opcionális|elhagyható|ízlés szerint|tetszés szerint|ha van\b|nem kötelező|díszítés|tálalás|a tetejére|feltétnek|feltétként|választható|helyettesíthető/;
const VEG_ALT = /zöldseg|gomba|vegan|növenyi|tofu|tempeh|seitan|hal|lazac|tonhal|víz|olaj|vaj|agar|sajt|tojas|bab|lencse|csicseri|padlizsan|cukkini/;
const GROUP_OPTIONAL = /tálal|díszít|opcionális|feltét|topping/;

/** Hungarian lengthens a stem's final a/e before suffixes (sonka → sonkával), so match on a/e-folded text. */
const fold = (s) => s.replace(/á/g, 'a').replace(/é/g, 'e');
const MEAT_F = MEAT.map(fold);
const strip = (s) => fold(NOT_MEAT.reduce((acc, re) => acc.replace(re, ' '), s.toLowerCase()));
const meatHits = (s) => {
  const t = strip(s);
  return MEAT_F.filter((m) => t.includes(m)).filter((m) => {
    if (m === 'here') return /\bhere\b/.test(t);
    if (m === 'mell') return /mell\b|mellfilé|mellé?nek|mellet\b|mellek|mell(?:ből|et|ek)\b/.test(t) || /(csirke|pulyka|kacsa|liba)mell/.test(t);
    if (m === 'comb') return /comb/.test(t);
    if (m === 'szív') return /szív\b|szívek|szívet/.test(t);
    if (m === 'gerinc') return /gerinc/.test(t);
    if (m === 'vese') return /vese\b|veséje|vesék/.test(t);
    if (m === 'maj') return /\bmaj\b|\bmajat|\bmajas|majkrem|majpaste|(?:csirke|liba|kacsa|marha|sertes|borju|pulyka|disznó|szarnyas)maj|kenőmaj/.test(t);
    if (m === 'fond') return /\bfond\b/.test(t);
    if (m === 'daralt') return /daralt\s*(?:hús|marha|sertes|pulyka|csirke|borjú|barany|vegyes)/.test(t);
    if (m === 'nyúl') return /nyúl(?:hús|comb|gerinc|\b)/.test(t);
    if (m === 'felvagott') return true;
    // An unqualified "alaplé" is taken as vegetable stock.
    if (m === 'alaple') return /(?:hús|csirke|marha|tyúk|borjú|szarnyas|kacsa|pulyka|sertes|csont|liba|barany|vad|nyúl)\S*[\s-]*(?:vagy\s+\S+\s+)?alaple|alaple\s*\((?:hús|csirke|marha|tyúk|borjú|szarnyas)/.test(t);
    if (m === 'liba') return !/libanon/.test(t);
    if (m === 'szív') return /szív\b|szívek|szívet/.test(t);
    if (['steak', 'burger', 'fasírt'].includes(m)) return !SEAFOOD.test(t);
    return true;
  });
};

/** Total grams named on a line (g, dkg, kg), or null. */
function grams(line) {
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|dkg|g)\b/i.exec(line);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return m[2].toLowerCase() === 'kg' ? v * 1000 : m[2].toLowerCase() === 'dkg' ? v * 10 : v;
}
/** Pieces like "4 db csirkemell", "2 szelet sonka". */
function pieces(line) {
  const m = /(\d+(?:[.,]\d+)?)\s*(db|darab|szelet|csík|egész|nagy|közepes|kis)\b/i.exec(line);
  return m ? { n: parseFloat(m[1].replace(',', '.')), unit: m[2].toLowerCase() } : null;
}
function servingsOf(rec) {
  const s = (rec.servings ?? []).join(' ');
  const m = /(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

function classify(rec) {
  const lines = [];
  for (const g of rec.ingredients ?? []) for (const it of g.items ?? []) if (it) lines.push({ group: g.group ?? '', text: it });
  const meatLines = [];
  for (const l of lines) {
    const hits = meatHits(l.text);
    if (!hits.length) continue;
    const t = fold(l.text.toLowerCase());
    let kind;
    if (SWAP_GEL.test(t) && hits.every((h) => h === 'zselatin')) kind = 'gelatin';
    else if (SWAP_BROTH.test(t) && hits.every((h) => /hús|csont|alaple|leveskocka|erőleves|fond|demi|csirke|marha|tyúk|borjú|szarnyas|kacsa|pulyka|sertes|liba/.test(h))) kind = 'broth';
    else if (SWAP_FAT.test(t) && hits.every((h) => /zsír|faggyú|kacsa|liba|sertes|disznó/.test(h))) kind = 'fat';
    else kind = 'core';
    const optional = OPTIONAL.test(l.text.toLowerCase()) || GROUP_OPTIONAL.test(l.group.toLowerCase());
    const vegAlt = /\bvagy\b/.test(l.text.toLowerCase()) && VEG_ALT.test(fold(l.text.toLowerCase().split(/\bvagy\b/).slice(1).join(' ')));
    meatLines.push({ ...l, hits, kind, optional, vegAlt, grams: grams(l.text), pieces: pieces(l.text) });
  }
  const nameHits = meatHits(rec.name ?? '');
  const steps = (rec.directions ?? []).flatMap((d) => d.steps ?? []).join(' ');
  const stepHits = meatHits(steps).filter((h) => !['comb', 'mell', 'szív', 'here', 'gerinc', 'csont', 'zsír', 'maj', 'vese', 'nyelv', 'fond', 'hús', 'alaple', 'felvagott', 'szarny', 'steak', 'burger', 'pecsenye'].includes(h));
  const ambiguousHus = meatLines.filter((m) => m.kind === 'core' && m.hits.every((h) => ['hús', 'comb', 'mell', 'szív', 'here', 'gerinc', 'csont', 'maj', 'vese', 'nyelv', 'steak', 'burger', 'gyros', 'kebab', 'pecsenye', 'fasírt', 'szarny', 'velő', 'felvagott', 'pastetom'].includes(h)));

  const base = { meatLines: meatLines.map((m) => m.text), nameHits, stepHits };
  if (!meatLines.length) {
    if (nameHits.length || stepHits.length)
      return { ...base, class: 'pescatarian', review: true, reason: `no meat ingredient, but ${nameHits.length ? `name mentions ${nameHits.join('/')}` : `steps mention ${stepHits.join('/')}`}` };
    return { ...base, class: 'pescatarian', review: false, reason: 'no meat, poultry, gelatin, lard or meat stock in the ingredients' };
  }
  const core = meatLines.filter((m) => m.kind === 'core' && !m.optional && !m.vegAlt);
  const soft = meatLines.filter((m) => !core.includes(m));
  const describeSoft = () =>
    soft.map((m) => (m.kind === 'core' ? (m.vegAlt ? 'meat variant with a vegetarian alternative' : 'optional/garnish meat') : `${m.kind} swap`)).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  if (!core.length) {
    const optCore = soft.filter((m) => m.kind === 'core');
    const nameIsMeat = optCore.some((m) => m.hits.some((h) => nameHits.includes(h)));
    const review = nameIsMeat || optCore.some((m) => (m.grams ?? 0) >= 150);
    return { ...base, class: 'optional-meat', review, reason: review ? `rules: ${describeSoft()} — but the title or amount suggests it is central` : `only ${describeSoft()}` };
  }
  const serv = servingsOf(rec) ?? 4;
  const totalG = core.reduce((s, m) => s + (m.grams ?? 0), 0);
  const bigPieces = core.some((m) => m.pieces && ['db', 'darab', 'egész', 'nagy', 'közepes'].includes(m.pieces.unit) && !m.hits.every((h) => ['velő', 'csont'].includes(h)));
  const nameMeat = core.some((m) => m.hits.some((h) => nameHits.includes(h))) || (nameHits.length > 0 && !nameHits.every((h) => ['hús', 'zsír', 'alaple', 'zselatin', 'felvagott', 'steak', 'burger', 'pecsenye', 'szív', 'comb', 'mell'].includes(h)));
  if (ambiguousHus.length === core.length && !nameMeat && totalG < 150)
    return { ...base, class: 'meat-main', review: true, reason: `ambiguous meat word(s) ${core.flatMap((m) => m.hits).join('/')} — check` };
  if (nameMeat) return { ...base, class: 'meat-main', review: false, reason: `meat in the title (${nameHits.join('/')}) and ingredients` };
  if (totalG >= 150 || totalG / serv >= 40) return { ...base, class: 'meat-main', review: false, reason: `${Math.round(totalG)} g of meat as a main component` };
  if (bigPieces) return { ...base, class: 'meat-main', review: true, reason: 'meat by the piece (db/whole) — likely main, check' };
  return { ...base, class: 'meat-main', review: true, reason: `small or unquantified meat (${Math.round(totalG)} g) not in the title — check whether removable` };
}

async function main() {
  const t0 = Date.now();
  const idsFile = path.resolve(ROOT, arg('--ids-file', 'scripts/data-raw/kifli/catalog-ids.txt'));
  const overridesFile = path.resolve(ROOT, arg('--overrides', 'scripts/data-raw/kifli/catalog-overrides.json'));
  const outFile = path.resolve(ROOT, arg('--out', 'scripts/data-raw/kifli/catalog-classes.json'));
  const ids = [...new Set((await readFile(idsFile, 'utf8')).split(/[\s,]+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
  const overrides = (await exists(overridesFile)) ? JSON.parse(await readFile(overridesFile, 'utf8')) : {};
  log(`kifli classify: ${ids.length} ids, ${Object.keys(overrides).length} manual decisions`);
  const out = [];
  let missing = 0;
  for (const [i, id] of ids.entries()) {
    const p = path.join(KIFLI, 'raw', `${id}.json`);
    if (!(await exists(p))) {
      missing++;
      continue;
    }
    const rec = JSON.parse(await readFile(p, 'utf8'));
    const r = classify(rec);
    const o = overrides[id];
    out.push({
      id,
      name: (rec.name ?? '').trim(),
      author: rec.author,
      authorType: rec.author === 'Kifli Kukták' ? 'ai' : 'human',
      class: o?.class ?? r.class,
      meatLines: r.meatLines,
      reason: o?.reason ?? r.reason,
      decidedBy: o ? 'manual' : 'rules',
      ruleClass: r.class,
      needsReview: !o && r.review,
    });
    if ((i + 1) % 500 === 0) log(`  ${i + 1}/${ids.length}`);
  }
  await writeFile(outFile, JSON.stringify(out, null, 1) + '\n');
  const tally = {};
  for (const r of out) tally[`${r.class}/${r.authorType}`] = (tally[`${r.class}/${r.authorType}`] ?? 0) + 1;
  const open = out.filter((r) => r.needsReview).length;
  log(`classified ${out.length} (${missing} ids not cached), ${open} still need review → ${path.relative(ROOT, outFile)}`);
  for (const [k, v] of Object.entries(tally).sort()) log(`  ${k.padEnd(24)} ${v}`);
  process.stdout.write(JSON.stringify({ classified: out.length, missing, needsReview: open, tally, secs: (Date.now() - t0) / 1000 }) + '\n');
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.exit(2);
});
