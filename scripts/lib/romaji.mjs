/**
 * Deterministic kana → Hepburn romanisation for MEXT food names. Hiragana and
 * katakana romanise exactly; kanji and other characters pass through unchanged
 * (MEXT ships no readings, so kanji-heavy names get partial romaji — the curated
 * English map in build-japan.mjs covers the foods recipes actually use). Handles
 * youon (きゃ→kya), sokuon (っ→ gemination), and the katakana long mark (ー).
 */

// Base hiragana → romaji (monographs). Katakana is folded to hiragana first.
const BASE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'o', ん: 'n', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
  っ: '', ー: '', '　': ' ', '・': ' ',
};

// Youon: a consonant kana + small や/ゆ/よ → digraph (sh/ch/j keep Hepburn forms).
const YOUON_HEAD = {
  き: 'ky', ぎ: 'gy', し: 'sh', じ: 'j', ち: 'ch', に: 'ny', ひ: 'hy',
  び: 'by', ぴ: 'py', み: 'my', り: 'ry',
};
const SMALL_Y = { ゃ: 'a', ゅ: 'u', ょ: 'o' };

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

/** Katakana (ァ–ヶ) → hiragana; leave the long mark ー and everything else as-is. */
function toHiragana(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x30a1 && c <= 0x30f6) return String.fromCodePoint(c - 0x60);
  return ch;
}

export function kanaToRomaji(input) {
  if (!input) return '';
  const s = [...input].map(toHiragana);
  let out = '';
  let pendingSokuon = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];

    if (ch === 'っ') { pendingSokuon = true; continue; }
    if (ch === 'ー') { // long vowel: repeat the last emitted vowel
      const last = out[out.length - 1];
      if (VOWELS.has(last)) out += last;
      continue;
    }

    let roman;
    if (YOUON_HEAD[ch] && SMALL_Y[next]) { roman = YOUON_HEAD[ch] + SMALL_Y[next]; i++; }
    else if (ch in BASE) roman = BASE[ch];
    else { out += ch; pendingSokuon = false; continue; } // kanji / punctuation pass-through

    if (pendingSokuon && roman) {
      const head = roman.startsWith('ch') ? 't' : roman[0];
      if (head && head !== ' ') roman = head + roman;
      pendingSokuon = false;
    }
    out += roman;
  }
  return out.replace(/\s+/g, ' ').trim();
}
