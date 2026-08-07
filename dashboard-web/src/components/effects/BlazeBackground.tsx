import { Blaze } from "./Blaze";

// A single page-wide fire layer: fixed to the viewport, behind all content,
// non-interactive. Sits above the grid overlay (z 0) and below page content
// (z 1) — see theme.css's .grid-overlay/.page z-index convention. No
// children — pure ambient background, so distortion is 0 (it only affects
// captured content, and there isn't any here).
//
// Tuned subtle per explicit direction: this dashboard just went through two
// rounds of removing a mismatched, attention-grabbing dark visual treatment
// in favor of something minimal — sparks/smoke/glow are all well below the
// component's own defaults so this reads as a quiet ember, not a blaze.
export function BlazeBackground() {
  return (
    <div aria-hidden className="blaze-background">
      <Blaze
        height={0.4}
        distortion={0}
        speed={0.6}
        sparks={0.22}
        sparkDensity={1.8}
        sparkSize={0.8}
        layers={3}
        smoke={0.15}
        glow={0.5}
        sparkColor={[0.18, 0, 1]}
        smokeColor={[0.26, 0.08, 1]}
        className="h-full w-full"
      >
        {null}
      </Blaze>
    </div>
  );
}
