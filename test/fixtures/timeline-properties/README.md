# timeline-properties fixture

A project saved by the Construct 3 r495.2 editor on 2026-09-17.

- `Box` (UID 1) sits at x 324, y 216, size 50 x 60, angle 0.5, z 5, color
  [0.25, 0.5, 0.75, 0.7], with a 1x1 frame and instance variables hp 7,
  tag "start" and on true.
- `timelines/Sampling.json` is the timeline as construct3-mcp wrote it: one
  track on Box with offsetX and offsetY keyframes at 0 and 1.
- `expected-Sampling-r495.json` is the same timeline after every entry in the
  editor's "Add properties" picker was added, in this order: Z, Width,
  Height, X scale, Y scale, Angle, Opacity, Color, hp, tag, on,
  Initial animation, Initial frame, Enable collisions. The file order of the
  property tracks is the editor's.
