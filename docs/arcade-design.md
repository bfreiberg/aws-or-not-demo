# Arcade design

Selected on 16 October 2026: Arcade, with the original app's concise wording.

The home page uses “Real AWS service, or made up?”, larger instruction text, and
short mode descriptions. Gameplay has a compact header and one status row above
the service name and equal-weight answer buttons. The question card has no
introductory slogans or repeated instructions.

Navy surfaces, orange-to-gold gradients, mint/coral answer feedback, score
increments, and promotion effects provide the visual identity. Decorative motion
respects reduced-motion preferences; promotions still dismiss automatically.
The timer, server grading, background statistics, and PNG sharing retain their
production behavior.

Implementation: `game/views.js`, `game/public/style.css`, `game/public/play.js`,
and `shared/card.js`. Browser fonts are copied from the existing Inter dependency
by `scripts/assets.js`; no external font service or animation library is used.

The exploratory A/B/C mock is retained locally under the gitignored
`game/prototype/` directory and excluded from production builds. Run its server
directly with `node game/prototype/server.js` if the old comparison is needed.
Its snapshot is `/tmp/aws-or-not-visual-prototype-2026-10-16.tar.gz` on the
development machine; it is not a shared repository artifact.
