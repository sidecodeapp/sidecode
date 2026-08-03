import Svg, { ClipPath, Defs, G, Polygon, Rect } from "react-native-svg";

/**
 * Thinkite brand mark — the sunrise-palette kite on a sky-blue rounded tile.
 * Vectored inline (react-native-svg) from the canonical source in
 * thinkite-brand/icon-master.svg (bare 200-grid geometry scaled 1.8x into a
 * 360 tile; kite bleeds off the top/right edge by design). Self-contained:
 * it paints its own #CFE6F5 background, so it reads identically in light and
 * dark. Inline (not an asset) avoids needing react-native-svg-transformer.
 */
export function ThinkiteMark({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 360 360">
      <Defs>
        <ClipPath id="tile">
          <Rect width={360} height={360} rx={80} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#tile)">
        <Rect width={360} height={360} fill="#CFE6F5" />
        <Polygon points="57.6,309.6 151.2,0 250.09,112.54" fill="#EE8A57" />
        <Polygon points="151.2,0 360,0 250.09,112.54" fill="#F6C67D" />
        <Polygon points="360,0 360,237.6 250.09,112.54" fill="#DB6480" />
        <Polygon points="57.6,309.6 250.09,112.54 360,237.6" fill="#7A63AC" />
      </G>
    </Svg>
  );
}
