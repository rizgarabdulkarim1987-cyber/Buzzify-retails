import type { CSSProperties } from "react";
import { dayAccent } from "./category-accent";
import { CategoryGlyph, OpenArrow } from "./category-icons";
import type { CategoryKind } from "./category-kind";

/**
 * One department as a near-black card: a thin accent border and a soft still glow in the accent, a
 * line glyph and a two-digit index at the top, the name large and bold, the quiet item count and a
 * small "Open" label with an arrow at the bottom. Static: the only state is the pressed one.
 */
export function CategoryTile({
  name,
  kind,
  accent,
  index,
  meta,
  action,
  onPick,
  testId = "sell-cat",
}: {
  name: string;
  kind: CategoryKind;
  accent: string;
  /** Two-digit position, "00" for the All tile. */
  index: string;
  /** The dim line under the name (how many items). */
  meta: string;
  /** The label at the bottom ("Open"). */
  action: string;
  onPick?: () => void;
  testId?: string;
}) {
  return (
    <button type="button" className="till-cattile" style={{ "--accent-night": accent, "--accent-day": dayAccent(accent) } as CSSProperties} onClick={onPick} data-kind={kind} data-testid={testId}>
      <span className="till-cattile-top">
        <CategoryGlyph kind={kind} />
        <span className="till-cattile-index" aria-hidden="true">
          {index}
        </span>
      </span>
      <span className="till-cattile-name">{name}</span>
      <span className="till-cattile-meta">{meta}</span>
      <span className="till-cattile-action">
        {action}
        <OpenArrow />
      </span>
    </button>
  );
}
