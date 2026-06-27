/**
 * React mirror of ScoreDial.astro — one ring-dial score medallion. Used by the
 * instant edit preview (RecipePreview) and the authoring Scores panel so the
 * client-rendered scores match the static detail page exactly. Data comes from
 * `buildScoreDials`; this file is purely presentational.
 */
import { toneText, toneBg, type ScoreDial as ScoreDialData } from '../../lib/recipe';

export default function ScoreDial({ dial }: { dial: ScoreDialData }) {
  // r = 15.9155 → circumference ≈ 100, so the arc length is the fill percentage.
  const dash = `${Math.round(dial.fill * 100)} 100`;
  return (
    <div
      className="group relative flex flex-col items-center text-center gap-1.5 rounded-xl bg-card border border-line px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-line"
      tabIndex={0}
      aria-label={`${dial.label}: ${dial.value}. ${dial.blurb}`}
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

      {dial.grades ? (
        <div className="mt-0.5 flex gap-0.5" aria-hidden="true">
          {dial.grades.map((g, i) => (
            <span
              key={g}
              className={`flex h-4 w-4 items-center justify-center rounded font-ui text-[0.6rem] font-semibold ${
                i === dial.activeGrade ? `${toneBg[dial.tone]} text-paper` : 'bg-paper-2 text-ink-faint'
              }`}
            >
              {g}
            </span>
          ))}
        </div>
      ) : (
        dial.scaleRef && <div className="font-ui text-[0.6rem] tabular-nums text-ink-faint">{dial.scaleRef}</div>
      )}

      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-56 max-w-[78vw] -translate-x-1/2 rounded-lg bg-ink px-3 py-2 text-left font-ui text-[0.7rem] font-normal normal-case leading-snug tracking-normal text-paper opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {dial.blurb}
      </div>
    </div>
  );
}
