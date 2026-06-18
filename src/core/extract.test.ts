import { describe, it, expect } from 'vitest';
import { extractRecipe, findRecipeNode, extractJsonLdNodes, cleanText } from './extract';

function ldScript(node: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
}

const GRAPH_HTML = `
<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "name": "Tasty Blog" },
    {
      "@type": ["Recipe", "Thing"],
      "name": "Red Lentil Dahl",
      "description": "A cozy &amp; quick dahl.",
      "image": { "@type": "ImageObject", "url": "https://ex.com/dahl.jpg" },
      "author": { "@type": "Person", "name": "Jane Cook" },
      "recipeYield": "4 servings",
      "prepTime": "PT10M",
      "cookTime": "PT30M",
      "recipeCuisine": "Indian",
      "recipeIngredient": ["1 cup red lentils", "2 cloves garlic"],
      "recipeInstructions": [
        { "@type": "HowToStep", "text": "Rinse the lentils." },
        { "@type": "HowToSection", "itemListElement": [
          { "@type": "HowToStep", "text": "Simmer 20 minutes." },
          { "@type": "HowToStep", "text": "Season &amp; serve." }
        ]}
      ]
    }
  ]
}
</script></head><body></body></html>`;

describe('extractRecipe (JSON-LD)', () => {
  const r = extractRecipe(GRAPH_HTML, { sourceUrl: 'https://www.tasty.example.com/dahl' })!;

  it('pulls the Recipe node out of an @graph', () => {
    expect(r.title).toBe('Red Lentil Dahl');
  });
  it('decodes HTML entities in text', () => {
    expect(r.description).toBe('A cozy & quick dahl.');
  });
  it('reads the image object url', () => {
    expect(r.imageUrl).toBe('https://ex.com/dahl.jpg');
  });
  it('keeps ingredient lines raw', () => {
    expect(r.ingredients).toEqual(['1 cup red lentils', '2 cloves garlic']);
  });
  it('flattens HowToStep and HowToSection instructions', () => {
    expect(r.instructions).toEqual([
      'Rinse the lentils.',
      'Simmer 20 minutes.',
      'Season & serve.',
    ]);
  });
  it('parses yield, times, cuisine and author', () => {
    expect(r.servings).toBe(4);
    expect(r.yield).toBe('4 servings');
    expect(r.prepTime).toBe('PT10M');
    expect(r.cookTime).toBe('PT30M');
    expect(r.cuisine).toBe('Indian');
    expect(r.author).toBe('Jane Cook');
  });
  it('derives source name from the url', () => {
    expect(r.sourceName).toBe('tasty.example.com');
    expect(r.sourceUrl).toBe('https://www.tasty.example.com/dahl');
  });
});

describe('extractRecipe (instruction strings)', () => {
  it('splits an HTML instruction blob into steps', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'X',
      recipeIngredient: ['a'],
      recipeInstructions: '<ol><li>Mix well.</li><li>Bake until golden.</li></ol>',
    })}</script>`;
    const r = extractRecipe(html)!;
    expect(r.instructions).toEqual(['Mix well.', 'Bake until golden.']);
  });
});

describe('extractRecipe (instruction edge shapes)', () => {
  it('handles a single HowToStep object (not wrapped in an array)', () => {
    const html = ldScript({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'X',
      recipeIngredient: ['a'],
      recipeInstructions: { '@type': 'HowToStep', text: 'Just mix it.' },
    });
    expect(extractRecipe(html)!.instructions).toEqual(['Just mix it.']);
  });

  it('skips malformed JSON-LD blocks but still reads a valid one', () => {
    const html =
      `<script type="application/ld+json">{ not valid json,, }</script>` +
      ldScript({ '@context': 'https://schema.org', '@type': 'Recipe', name: 'Survivor', recipeIngredient: ['x'] });
    expect(extractJsonLdNodes(html)).toHaveLength(1);
    expect(extractRecipe(html)!.title).toBe('Survivor');
  });

  it('ignores a non-serving number in recipeYield', () => {
    const html = ldScript({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'X',
      recipeIngredient: ['a'],
      recipeYield: '0 servings',
    });
    expect(extractRecipe(html)!.servings).toBeUndefined();
  });
});

describe('extractRecipe (OpenGraph fallback)', () => {
  it('falls back to the <title> element when no og:title/JSON-LD exists', () => {
    const html = `<html><head><title>Best Pancakes</title></head><body>no metadata</body></html>`;
    const r = extractRecipe(html)!;
    expect(r.title).toBe('Best Pancakes');
    expect(r.ingredients).toEqual([]);
  });

  it('falls back to og tags when there is no JSON-LD, order-independent', () => {
    const html = `<head>
      <meta property="og:title" content="Fallback Pie">
      <meta content="A tasty pie." property="og:description">
      <meta property="og:image" content="https://ex.com/pie.jpg">
    </head>`;
    const r = extractRecipe(html)!;
    expect(r.title).toBe('Fallback Pie');
    expect(r.description).toBe('A tasty pie.');
    expect(r.imageUrl).toBe('https://ex.com/pie.jpg');
    expect(r.ingredients).toEqual([]);
    expect(r.instructions).toEqual([]);
  });
  it('returns null when there is nothing usable', () => {
    expect(extractRecipe('<html><body>nope</body></html>')).toBeNull();
  });
});

describe('findRecipeNode', () => {
  it('matches when @type is an array including Recipe', () => {
    expect(findRecipeNode([{ '@type': ['Thing', 'Recipe'], name: 'Y' }])).not.toBeNull();
    expect(findRecipeNode([{ '@type': 'WebPage' }])).toBeNull();
  });
});

describe('cleanText', () => {
  it('strips tags, decodes entities and collapses whitespace', () => {
    expect(cleanText('<p>Hi   <b>there</b></p>')).toBe('Hi there');
    expect(cleanText('a &amp; b &#233; c')).toBe('a & b é c');
  });
  it('removes entity-escaped markup rather than resurrecting it', () => {
    expect(cleanText('keep &lt;b&gt;bold&lt;/b&gt; word')).toBe('keep bold word');
  });
  it('drops out-of-range / control numeric entities without throwing', () => {
    expect(cleanText('a&#9999999;b')).toBe('ab'); // beyond Unicode max
    expect(cleanText('a&#0;b')).toBe('ab'); // NUL
  });
});
