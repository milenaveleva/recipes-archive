import { describe, it, expect } from 'vitest';
import { refCategoryFor } from './gi-category.mjs';

const baked = (description) => refCategoryFor({ category: 'Baked Products', description });

describe('refCategoryFor', () => {
  it('routes a US "Biscuits, …" quick bread to BREADS, not COOKIES', () => {
    expect(baked('Biscuits, mixed grain, refrigerated dough')).toBe('BREADS');
    expect(baked('Biscuits, plain or buttermilk, prepared from recipe')).toBe('BREADS');
  });

  it('keeps crackers, cookies and the rest of the bakery section apart', () => {
    expect(baked('Crackers, water biscuits')).toBe('CRACKERS');
    expect(baked('Cookies, oatmeal, commercially prepared')).toBe('COOKIES');
    expect(baked('Digestive biscuits, plain')).toBe('COOKIES');
    expect(baked('Bread, whole-wheat, commercially prepared')).toBe('BREADS');
    expect(baked('Wonton wrappers (includes egg roll wrappers)')).toBe('PASTA AND NOODLES');
    expect(baked('Cake, pound, commercially prepared')).toBe('BAKERY PRODUCTS');
  });

  it('maps the other USDA categories by name', () => {
    expect(refCategoryFor({ category: 'Cereal Grains and Pasta', description: 'Pasta, dry, enriched' })).toBe('PASTA AND NOODLES');
    expect(refCategoryFor({ category: 'Cereal Grains and Pasta', description: 'Rice, brown, long-grain, raw' })).toBe('CEREAL GRAINS');
    expect(refCategoryFor({ category: 'Fruits and Fruit Juices', description: 'Apples, raw' })).toBe('FRUIT AND FRUIT PRODUCTS');
    expect(refCategoryFor({ category: 'Fats and Oils', description: 'Oil, olive' })).toBeNull();
  });
});
