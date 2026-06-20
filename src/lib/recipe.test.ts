import { describe, it, expect } from 'vitest';
import {
  giFill,
  glFill,
  inflammationFill,
  buildScoreDials,
  hasAnyScore,
  nutriGrades,
  GL_DIAL_MAX,
} from './recipe';

describe('score dial fills (emptier ring = healthier)', () => {
  it('maps GI onto its 0–100 scale and clamps', () => {
    expect(giFill(0)).toBe(0);
    expect(giFill(64)).toBeCloseTo(0.64);
    expect(giFill(100)).toBe(1);
    expect(giFill(140)).toBe(1); // clamp above
    expect(giFill(null)).toBe(0);
    expect(giFill(undefined)).toBe(0);
  });

  it('saturates GL at GL_DIAL_MAX', () => {
    expect(glFill(0)).toBe(0);
    expect(glFill(10)).toBeCloseTo(0.5);
    expect(glFill(GL_DIAL_MAX)).toBe(1);
    expect(glFill(40)).toBe(1); // clamp above the cap
    expect(glFill(null)).toBe(0);
  });

  it('centres inflammation on its −2 … +2 range', () => {
    expect(inflammationFill(-2)).toBe(0); // most anti → empty (best)
    expect(inflammationFill(0)).toBeCloseTo(0.5);
    expect(inflammationFill(2)).toBe(1); // most pro → full (worst)
    expect(inflammationFill(-0.8)).toBeCloseTo(0.3);
    expect(inflammationFill(-5)).toBe(0); // clamp below
    expect(inflammationFill(null)).toBe(0);
  });
});

describe('buildScoreDials', () => {
  const nutrition = {
    glycemic: { gi: 64, gl: 19, giBand: 'medium', glBand: 'medium' },
    nutriScore: { grade: 'C' },
    inflammation: { score: -0.8, band: 'mildly-anti-inflammatory' },
  };

  it('returns the four dials with value, tone, fill and scale', () => {
    const [gi, gl, nutri, inflam] = buildScoreDials(nutrition);

    expect(gi.value).toBe('64');
    expect(gi.tone).toBe('mid');
    expect(gi.fill).toBeCloseTo(0.64);
    expect(gi.scaleRef).toBe('0–100');

    expect(gl.value).toBe('19');
    expect(gl.sub).toBe('medium');

    expect(nutri.value).toBe('C');
    expect(nutri.fill).toBe(1); // categorical → full ring
    expect(nutri.grades).toEqual(nutriGrades);
    expect(nutri.activeGrade).toBe(2); // A,B,C → index 2

    expect(inflam.value).toBe('-0.8');
    expect(inflam.tone).toBe('good');
  });

  it('shows em-dash placeholders and an inactive grade when nutrition is empty', () => {
    const [gi, , nutri] = buildScoreDials(undefined);
    expect(gi.value).toBe('—');
    expect(gi.fill).toBe(0);
    expect(nutri.value).toBe('—');
    expect(nutri.activeGrade).toBe(-1);
  });

  it('leaves the GL sub empty (no duplicate "per serving") when glBand is absent or blank', () => {
    const [, gl] = buildScoreDials({ glycemic: { gl: 12 } });
    expect(gl.sub).toBeUndefined();
    expect(gl.scaleRef).toBe('per serving'); // shown once, via scaleRef only
    const [giBlank] = buildScoreDials({ glycemic: { gi: 50, giBand: '' } });
    expect(giBlank.sub).toBeUndefined();
  });

  it('prefixes positive inflammation scores with +', () => {
    const [, , , inflam] = buildScoreDials({ inflammation: { score: 1.2, band: 'mildly-pro-inflammatory' } });
    expect(inflam.value).toBe('+1.2');
    expect(inflam.tone).toBe('bad');
  });
});

describe('hasAnyScore', () => {
  it('is true when any scored block is present', () => {
    expect(hasAnyScore({ nutriScore: { grade: 'A' } })).toBe(true);
    expect(hasAnyScore({ glycemic: { gi: 50 } })).toBe(true);
    expect(hasAnyScore({ inflammation: { score: 0, band: 'neutral' } })).toBe(true);
  });
  it('is false for an empty or macros-only block', () => {
    expect(hasAnyScore(undefined)).toBe(false);
    expect(hasAnyScore({})).toBe(false);
  });
});
