/**
 * React mirror of ScoreDial.astro — one ring-dial score medallion. Used by the
 * instant edit preview (RecipePreview) and the authoring Scores panel so the
 * client-rendered scores match the static detail page exactly. Data comes from
 * `buildScoreDials`; this file is purely presentational.
 */
import { toneText, tipAlignClass, type ScoreDial as ScoreDialData, type TooltipAlign } from '../../lib/recipe';

export default function ScoreDial({ dial, align = 'center' }: { dial: ScoreDialData; align?: TooltipAlign }) {
  // r = 15.9155 → circumference ≈ 100, so the arc length is the fill percentage.
  const dash = `${Math.round(dial.fill * 100)} 100`;
  const tipAlign = tipAlignClass(align);
  // The native value may carry a typographic minus (U+2212, e.g. "−0.8"), which some
  // screen readers don't voice as "minus" — swap it for an ASCII hyphen in the accessible
  // name so a negative inflammation value is never heard as positive.
  const ariaValue = dial.present
    ? `${dial.value} out of 10${dial.scaleRef ? ` (${dial.scaleRef.replace('−', '-')})` : ''}`
    : 'not available';
  return (
    <div
      className="group relative flex flex-col items-center text-center gap-1.5 rounded-xl bg-card border border-line px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-spice focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
      role="img"
      tabIndex={0}
      aria-label={`${dial.label}: ${ariaValue}. ${dial.blurb}`}
    >
      <div className="relative h-16 w-16">
        <svg viewBox="0 0 36 36" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="15.9155" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-line" />
          {dial.fill > 0 && (
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={dash}
              className={toneText[dial.tone]}
            />
          )}
        </svg>
        <div
          className={`absolute inset-0 flex items-center justify-center font-display font-semibold text-ink ${
            dial.value.length > 3 ? 'text-xl' : 'text-2xl'
          }`}
        >
          {dial.value}
        </div>
      </div>

      <div className="eyebrow !text-[0.62rem] !tracking-[0.14em] leading-tight text-ink-soft">{dial.label}</div>
      {dial.sub && <div className="font-ui text-[0.66rem] capitalize leading-tight text-ink-faint">{dial.sub}</div>}

      {dial.scaleRef && <div className="font-ui text-[0.6rem] tabular-nums text-ink-faint">{dial.scaleRef}</div>}

      <div
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-full z-30 mb-2 w-56 max-w-[78vw] rounded-lg bg-ink px-3 py-2 text-left font-ui text-[0.7rem] font-normal normal-case leading-snug tracking-normal text-paper opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${tipAlign}`}
      >
        {dial.blurb}
      </div>
    </div>
  );
}
